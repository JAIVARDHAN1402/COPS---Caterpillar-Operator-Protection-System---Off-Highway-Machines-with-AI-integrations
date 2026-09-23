"""Shift handover: everything the incoming operator needs to know, in 30 seconds."""
from collections import Counter

from .domain import OPERATORS, SHIFT_END_MIN, SHIFT_START_MIN, fmt
from .ml import confidence

HANDOVER_REASONS = [
    "Medical emergency",
    "Personal emergency",
    "Fatigue / unfit to continue",
    "Planned end of shift",
]

# What a half-finished task leaves behind on site.
IN_PROGRESS_HAZARD = {
    "Trenching": "Open trench at {site} ({pct}% dug). Keep machine & spoil pile ≥1 m from the edge.",
    "Earth Excavation": "Partially dug pit at {site} ({pct}% done). Pit edges may be unstable.",
    "Demolition": "Partially demolished structure at {site} ({pct}% down). Do not approach from the unfinished side.",
    "Grading": "Road partially graded at {site} ({pct}%). Uneven surface / level step.",
    "Material Loading": "Loading at {site} paused ({pct}%). A dumper may be waiting at the stockpile.",
}


def to_min(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def worked_until(plan):
    """Time of day the outgoing operator effectively reached, from the task timeline."""
    t = SHIFT_START_MIN
    for p in plan:
        if p["status"] == "done":
            t = max(t, to_min(p["end"]))
        elif p["status"] in ("in_progress", "paused"):
            t = max(t, to_min(p["start"]) + p["prediction"]["predicted_min"] * p.get("progress", 0))
    return int(round(t))


def dur(minutes):
    minutes = int(round(minutes))
    return f"{minutes // 60}h {minutes % 60:02d}m" if minutes >= 60 else f"{minutes} min"


def build_brief(h, plan, incoming, events, incidents, forecast, machine_last):
    """Brief for the INCOMING operator: predictions use *their* skill level."""
    frm = OPERATORS[h["from_operator"]]
    done = [p for p in plan if p["status"] == "done"]
    current = next((p for p in plan if p["status"] in ("paused", "in_progress")), None)
    remaining = [p for p in plan if p["status"] == "pending"]
    t0 = h["handover_min"]

    cur_left = current["prediction"]["predicted_min"] * (1 - current["progress"]) if current else 0
    remaining_min = cur_left + sum(p["prediction"]["predicted_min"] for p in remaining) + 10 * len(remaining)
    eta = t0 + remaining_min
    overflow = eta - SHIFT_END_MIN

    hazards = []
    if current:
        hazards.append(IN_PROGRESS_HAZARD[current["task_type"]].format(
            site=current["site"], pct=round(current["progress"] * 100)))
    ahead = [x for x in forecast if t0 // 60 <= x["hour"] < SHIFT_END_MIN // 60 + 1]
    rain = [x["hour"] for x in ahead if x["condition"] == "Rainy"]
    wind = [x for x in ahead if x["condition"] == "Windy"]
    if rain:
        hazards.append(f"Rain expected {rain[0]}:00–{rain[-1] + 1}:00. Trench walls & ground softening.")
    if wind:
        hazards.append(f"Wind up to {max(w['wind_kmh'] for w in wind)} km/h from {wind[0]['hour']}:00. Pause high-reach work.")
    hot = [x for x in ahead if x["heat_index"] >= 38]
    if hot:
        hazards.append(f"Heat index up to {max(x['heat_index'] for x in hot)}°C. Hydrate every 30 min.")
    for inc in incidents:
        hazards.append(f"Incident {inc['id']} this shift: {inc['primary_type']} at {inc['location']} ({inc['severity']}).")

    ev = Counter(e["type"] for e in events)
    ev_text = ", ".join(f"{n} {k}" for k, n in ev.items())

    if t0 > SHIFT_START_MIN:
        s = [f"{frm['name']} worked {fmt(SHIFT_START_MIN)} to {fmt(t0)} ({dur(t0 - SHIFT_START_MIN)}) "
             f"and left due to {h['reason'].lower()}."]
    else:
        s = [f"{frm['name']} handed over before starting any work ({h['reason'].lower()}). You are starting the shift fresh."]
    if done or current:
        s.append(f"{len(done)} of {len(plan)} tasks {'is' if len(done) == 1 else 'are'} done" +
                 (f": {', '.join(p['task_type'] for p in done)}." if done else "."))
    if current:
        s.append(f"{current['task_type']} was stopped at about {round(current['progress'] * 100)}%, "
                 f"roughly {cur_left:.0f} minutes left.")
    s.append(f"{len(remaining)} more task{'s' if len(remaining) != 1 else ''} remain. "
             f"At your {incoming['skill'].lower()} pace this is about {dur(remaining_min)}, finishing around {fmt(eta)}"
             + (f", {overflow:.0f} minutes past the {fmt(SHIFT_END_MIN)} shift end." if overflow > 0
                else f", within the {fmt(SHIFT_END_MIN)} shift end."))
    if hazards:
        s.append(f"Watch out: {hazards[0]}")

    avg_task_conf = [p["prediction"]["confidence"]["score"] for p in remaining] or [0.85]
    conf = confidence(
        min(sum(avg_task_conf) / len(avg_task_conf), 0.95) - (0.1 if current else 0),
        "Task log + ML time predictions for the incoming operator",
        [f"{len(done)} completed tasks with logged actual times",
         f"Remaining time predicted for {incoming['name']} ({incoming['skill']})",
         f"{sum(ev.values())} safety events and {len(incidents)} incidents from the outgoing shift"],
        (["In-progress % was reported by the outgoing operator, not measured"] if current else [])
        + ["Finish time assumes no further interruptions"])

    return {
        "id": h["id"], "machine_id": h["machine_id"], "reason": h["reason"], "note": h.get("note", ""),
        "created": h["created"], "status": h["status"],
        "from_operator": {"id": frm["id"], "name": frm["name"]},
        "shift": {"start": fmt(SHIFT_START_MIN), "end": fmt(SHIFT_END_MIN), "handover_at": fmt(t0),
                  "worked": dur(t0 - SHIFT_START_MIN), "left_in_shift": dur(max(0, SHIFT_END_MIN - t0))},
        "done": [{"task_id": p["task_id"], "task_type": p["task_type"], "site": p["site"],
                  "actual_min": p["actual_min"], "done_by": OPERATORS.get(p["done_by"], {}).get("name", "")}
                 for p in done],
        "current": current and {"task_id": current["task_id"], "task_type": current["task_type"],
                                "site": current["site"], "progress": current["progress"],
                                "remaining_min": round(cur_left)},
        "remaining": [{"task_id": p["task_id"], "task_type": p["task_type"], "site": p["site"],
                       "priority": p["priority"], "predicted_min": p["prediction"]["predicted_min"],
                       "weather": p["weather"]} for p in remaining],
        "remaining_min": round(remaining_min), "eta": fmt(eta), "overflow_min": max(0, round(overflow)),
        "hazards": hazards, "events": ev_text, "machine": machine_last,
        "summary": " ".join(s), "confidence": conf,
    }
