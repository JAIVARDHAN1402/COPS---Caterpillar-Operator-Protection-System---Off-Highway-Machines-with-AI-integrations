"""Operators, weather forecast, smart scheduler, incident parser, training content."""
import datetime as dt
import random
import re
from itertools import permutations

from .ml import confidence

MACHINES = {
    "EXC001": {"machine_id": "EXC001", "machine": "CAT 320 Excavator", "machine_age": 4},
    "EXC002": {"machine_id": "EXC002", "machine": "CAT 336 Excavator", "machine_age": 2},
    "LDR001": {"machine_id": "LDR001", "machine": "CAT 950 Wheel Loader", "machine_age": 6},
}

# machine_id = the operator's home machine (they can take over another one at handover)
OPERATORS = {
    "OP1001": {"id": "OP1001", "name": "Raju Kumar", "machine_id": "EXC001", "xp": 150, "language": "hi-IN"},
    "OP1002": {"id": "OP1002", "name": "Priya Sharma", "machine_id": "EXC002", "xp": 420, "language": "en-IN"},
    "OP1003": {"id": "OP1003", "name": "Arjun Singh", "machine_id": "LDR001", "xp": 40, "language": "hi-IN"},
}

SHIFT_START_MIN = 8 * 60
SHIFT_END_MIN = 13 * 60


def skill_from_xp(xp):
    if xp >= 300:
        return "Expert", None
    if xp >= 100:
        return "Intermediate", 300
    return "Beginner", 100


# ---------------------------------------------------------------- forecast
def forecast(date=None):
    """Deterministic per-day hourly forecast (simulated weather API)."""
    date = date or dt.date.today()
    rng = random.Random(date.toordinal())
    # Rain late-morning, wind early-afternoon: clashes with the default task order,
    # which is what the smart scheduler is there to fix.
    rain_start = rng.choice([10, 11])
    wind_hour = rng.choice([13, 14])
    hours = []
    for h in range(7, 19):
        temp = round(27 + 9 * max(0, 1 - abs(h - 14) / 6) + rng.uniform(-0.8, 0.8), 1)
        cond = "Sunny" if 9 < h < 17 else "Cloudy"
        if rain_start <= h < rain_start + 2:
            cond = "Rainy"
        elif h in (wind_hour, wind_hour + 1):
            cond = "Windy"
        heat_index = round(temp + (4 if cond == "Sunny" else 0), 1)
        hours.append({"hour": h, "condition": cond, "temp_c": temp, "heat_index": heat_index,
                      "wind_kmh": 38 if cond == "Windy" else rng.randint(6, 16)})
    return hours


def weather_at(fc, minute_of_day):
    h = max(7, min(18, minute_of_day // 60))
    return next(x for x in fc if x["hour"] == h)


# Which weather hurts which task (used by the smart scheduler).
WEATHER_SENSITIVITY = {
    "Earth Excavation": {"Rainy": 3},
    "Trenching": {"Rainy": 4},       # trench wall collapse risk in rain
    "Grading": {"Rainy": 3},
    "Demolition": {"Windy": 4},      # debris + dust drift in wind
    "Material Loading": {},
}

TODAY_TASKS = [
    {"task_id": "T001", "task_type": "Earth Excavation", "site": "Block A - foundation pit", "priority": "High"},
    {"task_id": "T002", "task_type": "Trenching", "site": "Utility line, East gate", "priority": "High"},
    {"task_id": "T003", "task_type": "Material Loading", "site": "Stockpile 2 → dumper", "priority": "Medium"},
    {"task_id": "T004", "task_type": "Grading", "site": "Access road, 120 m", "priority": "Medium"},
    {"task_id": "T005", "task_type": "Demolition", "site": "Old pump house", "priority": "Low"},
]


TRANSITION_MIN = 10  # repositioning between tasks
PRIORITY_RANK = {"High": 0, "Medium": 1, "Low": 2}


MAX_WAIT_MIN = 20


def _timeline(order, durations, fc, start_min):
    """Lay tasks out in time; return per-task (start, end, dominant weather, risk cost, wait).

    If a task would start in bad weather that clears within 20 min, it waits
    (the operator uses the gap as a hydration break).
    """
    clock, out = start_min, []
    for t in order:
        dur = durations[t["task_id"]]
        sens = WEATHER_SENSITIVITY[t["task_type"]]
        wait = 0
        next_hour = (int(clock) // 60 + 1) * 60
        if (sens.get(weather_at(fc, clock)["condition"]) and next_hour - clock <= MAX_WAIT_MIN
                and not sens.get(weather_at(fc, next_hour)["condition"])):
            wait, clock = next_hour - clock, next_hour
        risk, conds = 0, {}
        for m in range(int(clock), int(clock + dur), 15):  # sample every 15 min
            c = weather_at(fc, m)["condition"]
            conds[c] = conds.get(c, 0) + 1
            risk += sens.get(c, 0)
        worst = max(conds, key=lambda c: (sens.get(c, 0), conds[c]))
        out.append((clock, clock + dur, worst, risk, wait))
        clock += dur + TRANSITION_MIN
    return out


def plan_day(predictor, skill, machine_age, statuses, fc, start_min=8 * 60):
    """Weather-aware scheduler.

    Tries every ordering of the pending tasks (5! = 120, instant) and picks
    the one with the least weather exposure over each task's FULL duration,
    with a small penalty for doing high-priority work late. Started or
    finished tasks stay pinned at the front.
    """
    naive_order = [t["task_id"] for t in TODAY_TASKS]
    pinned = [t for t in TODAY_TASKS if statuses.get(t["task_id"], {}).get("status") in ("done", "in_progress", "paused")]
    pinned.sort(key=lambda t: statuses[t["task_id"]].get("started_at", ""))
    pending = [t for t in TODAY_TASKS if t not in pinned]

    # Duration estimate per task at mid-shift weather (refined after ordering).
    durations = {}
    for t in TODAY_TASKS:
        st = statuses.get(t["task_id"], {})
        durations[t["task_id"]] = st.get("actual_min") or predictor.predict(t["task_type"], "Cloudy", skill, machine_age)["predicted_min"]

    def score(order):
        tl = _timeline(order, durations, fc, start_min)
        weather_cost = sum(x[3] for x in tl)
        waiting = sum(x[4] for x in tl)
        lateness = sum(i * (2 - PRIORITY_RANK[t["priority"]]) for i, t in enumerate(order))
        return weather_cost * 10 + waiting * 0.5 + lateness

    best = min((pinned + list(p) for p in permutations(pending)), key=score)
    naive_timeline = _timeline(TODAY_TASKS, durations, fc, start_min)
    naive_tl = {t["task_id"]: tl for t, tl in zip(TODAY_TASKS, naive_timeline)}

    # Final pass: predict with the weather each task will actually face.
    for t, (s, e, w, *_) in zip(best, _timeline(best, durations, fc, start_min)):
        durations[t["task_id"]] = statuses.get(t["task_id"], {}).get("actual_min") or \
            predictor.predict(t["task_type"], w, skill, machine_age)["predicted_min"]
    plan = []
    for i, (t, (s, e, w, _, wait)) in enumerate(zip(best, _timeline(best, durations, fc, start_min))):
        st = statuses.get(t["task_id"], {})
        reason = None
        ns, _, nw, nrisk, _ = naive_tl[t["task_id"]]
        if naive_order.index(t["task_id"]) != i and t not in pinned:
            if nrisk and weather_risk(t["task_type"], nw) != "low":
                reason = f"Moved from {fmt(ns)} to avoid {nw.lower()} weather (risky for {t['task_type'].lower()})"
            else:
                reason = f"Shifted to {fmt(s)} so weather-sensitive tasks get the safe slots"
        plan.append({**t, "weather": w, "start": fmt(s), "end": fmt(e), "wait_before": round(wait),
                     "prediction": predictor.predict(t["task_type"], w, skill, machine_age),
                     "status": st.get("status", "pending"), "actual_min": st.get("actual_min"),
                     "done_by": st.get("operator_id"), "progress": st.get("progress", 0),
                     "reason": reason, "risk": weather_risk(t["task_type"], w)})
    # How many tasks would have hit risky weather in the supervisor's original order.
    naive_risky = sum(1 for t, x in zip(TODAY_TASKS, naive_timeline)
                      if weather_risk(t["task_type"], x[2]) != "low")
    return plan, naive_risky


def weather_risk(task_type, cond):
    s = WEATHER_SENSITIVITY[task_type].get(cond, 0)
    return "high" if s >= 4 else "medium" if s >= 2 else "low"


def fmt(minutes):
    minutes = int(round(minutes))
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


# ---------------------------------------------------------------- incidents
INCIDENT_TYPES = [
    ("Injury", r"injur|hurt|bleed|fracture|cut (his|her|my)|fell|fall"),
    ("Collision", r"hit|struck|collid|crash|bump|dent"),
    ("Near Miss", r"near miss|almost|nearly|close call|narrowly"),
    ("Rollover / Tip", r"roll|tip|tilt|overturn"),
    ("Utility Strike", r"cable|pipe|gas line|water line|wire|utility"),
    ("Spill / Leak", r"leak|spill|oil|hydraulic fluid|fuel"),
    ("Equipment Damage", r"broke|crack|damage|windshield|glass|bucket|track"),
    ("Ground Collapse", r"collapse|cave|landslide|trench wall"),
]
SEVERITY_WORDS = {
    "Critical": r"injur|bleed|fracture|unconscious|gas line|rollover|overturn|collapse",
    "High": r"hit|struck|crash|cable|pipe|leak|broke|crack",
}
BODY = r"(head|hand|arm|leg|foot|back|eye|finger)"


def parse_incident(text):
    """Offline rule-based NLP: turns a spoken sentence into a structured report."""
    t = text.lower()
    # Remove negated phrases ("nobody was hurt", "no one injured") before matching.
    t_pos = re.sub(r"\b(no ?one|nobody|none|not|no|without)\b[^,.;]{0,25}?\b(hurt|injur\w*|bleed\w*|damage\w*)", " ", t)
    types = [name for name, pat in INCIDENT_TYPES if re.search(pat, t_pos)] or ["Other"]
    if "Near Miss" in types:  # "almost hit" is a near miss, not a collision
        types = ["Near Miss"] + [x for x in types if x not in ("Near Miss", "Collision")]
    severity = "Low"
    for sev, pat in SEVERITY_WORDS.items():
        if re.search(pat, t_pos):
            severity = sev
            break
    persons = bool(re.search(r"worker|person|man|woman|helper|labou?r|someone|pedestrian|colleague", t))
    if types[0] == "Near Miss":
        # A near miss involving a person is never "low" - it is a fatality that didn't happen.
        severity = "Medium" if severity in ("High", "Critical") or persons else severity
    locs = re.findall(r"\b(?:near|at|in|beside|by|behind)\s+(?:the\s+)?([a-z0-9 \-]{2,30}?)(?=[,.]|$| and | while | when | during )", t)
    locs = [l for l in locs if l.strip() not in ("machine", "cab", "morning", "evening")]
    loc = re.split(r"\b(?:at|near|by|in)\s+(?:the\s+)?", locs[-1])[-1] if locs else None
    body = re.findall(BODY, t)
    actions = {
        "Injury": "Give first aid, call site medic, stop machine and secure area",
        "Collision": "Stop machine, inspect damage, check for injured persons",
        "Near Miss": "Review spotter / exclusion zone setup before resuming",
        "Utility Strike": "STOP. Evacuate 30 m, call utility emergency line",
        "Spill / Leak": "Shut engine, contain spill with absorbent kit",
        "Rollover / Tip": "Stay in cab with seatbelt on, wait for rescue",
        "Equipment Damage": "Tag out machine, request maintenance inspection",
        "Ground Collapse": "Move machine back from edge, barricade area",
        "Other": "Inform supervisor",
    }
    type_matched = types[0] != "Other"
    sev_matched = any(re.search(p, t_pos) for p in SEVERITY_WORDS.values())
    basis = [f"Type matched from keywords: {', '.join(types)}" if type_matched else "No incident keywords recognised",
             f"Location extracted: '{loc.strip().title()}'" if loc else "No location phrase found",
             "Severity keywords found" if sev_matched else "Severity defaulted (no severity keywords)"]
    caveats = ["Rule-based language parser. Please review fields before submitting"]
    if len(types) > 2:
        caveats.append("Several incident types matched; primary type may need correction")
    conf = confidence(0.4 + 0.3 * type_matched + 0.12 * bool(loc) + 0.08 * sev_matched - 0.05 * (len(types) > 2),
                      "Keyword + pattern NLP (offline)", basis, caveats)
    return {
        "confidence": conf,
        "description": text.strip(),
        "types": types,
        "primary_type": types[0],
        "severity": severity,
        "location": loc.strip().title() if loc else "Unknown - add location",
        "persons_involved": persons,
        "body_parts": sorted(set(body)),
        "recommended_action": actions[types[0]],
        "notify_supervisor": severity in ("Critical", "High") or persons,
    }


# ---------------------------------------------------------------- training
TRAINING_MODULES = [
    {"id": "M1", "tag": "seatbelt", "icon": "🪢", "title": "Why the seatbelt is your lifeline",
     "duration_sec": 60, "xp": 40,
     "slides": ["In a rollover, an unbelted operator is thrown into the path of the cab or the machine itself. The ROPS cab only protects you if you stay inside it.",
                "Most rollovers happen at low speed on slopes or trench edges - the moments that feel 'safe'.",
                "Rule: belt on BEFORE the engine starts. If you step out, lower the bucket and shut down."],
     "quiz": [{"q": "When should you fasten the seatbelt?", "options": ["Only on slopes", "Before starting the engine", "Only when travelling"], "answer": 1},
              {"q": "In a tip-over, you should...", "options": ["Jump out quickly", "Stay in the cab, belted, hold on"], "answer": 1}]},
    {"id": "M2", "tag": "idling", "icon": "⛽", "title": "Idling: the silent money leak",
     "duration_sec": 60, "xp": 30,
     "slides": ["An excavator idling burns about 3.5 litres of diesel an hour - ₹320/hour doing nothing.",
                "Idling also adds engine hours, which brings service intervals closer and reduces resale value.",
                "Rule: waiting more than 5 minutes? Lower attachments, and shut down. Use auto-idle / auto-shutdown."],
     "quiz": [{"q": "Idle burn of an excavator per hour is about...", "options": ["0.2 L", "3.5 L", "20 L"], "answer": 1},
              {"q": "Waiting 10 minutes for a truck, you should...", "options": ["Keep engine running", "Lower bucket & shut down"], "answer": 1}]},
    {"id": "M3", "tag": "proximity", "icon": "👷", "title": "Blind spots & the exclusion zone",
     "duration_sec": 75, "xp": 40,
     "slides": ["The rear counterweight of an excavator swings through a zone you cannot see. Most struck-by fatalities happen here.",
                "Keep a minimum 3 m exclusion zone plus the full swing radius. Use a spotter when people must work nearby.",
                "If someone enters the zone: STOP all movement, make eye contact, wait until they are clear."],
     "quiz": [{"q": "Minimum exclusion zone beyond swing radius?", "options": ["0.5 m", "3 m", "No zone needed"], "answer": 1},
              {"q": "A worker walks behind you. You...", "options": ["Sound horn and keep swinging", "Stop all movement until clear"], "answer": 1}]},
    {"id": "M4", "tag": "rain", "icon": "🌧️", "title": "Wet-weather trenching",
     "duration_sec": 60, "xp": 30,
     "slides": ["Rain adds weight and removes friction - trench walls can collapse without warning.",
                "Keep the machine and spoil pile at least 1 m (or trench depth) back from the edge.",
                "Watch for cracks parallel to the trench and water seeping from the walls: back off and report."],
     "quiz": [{"q": "Spoil pile should be kept...", "options": ["Right on the edge", "At least 1 m back"], "answer": 1}]},
    {"id": "M5", "tag": "wind", "icon": "💨", "title": "Demolition in windy conditions",
     "duration_sec": 60, "xp": 30,
     "slides": ["Wind carries dust and light debris far outside the planned drop zone.",
                "Above ~40 km/h, pause high-reach work. Use water suppression for dust.",
                "Always demolish top-down and away from the wind direction toward people."],
     "quiz": [{"q": "At strong wind (>40 km/h) high-reach demolition should...", "options": ["Continue faster", "Pause"], "answer": 1}]},
    {"id": "M6", "tag": "fatigue", "icon": "😴", "title": "Heat, hydration & fatigue",
     "duration_sec": 60, "xp": 30,
     "slides": ["Cab temperatures can exceed 40°C. Dehydration of just 2% slows reaction time noticeably.",
                "Drink water every 30 minutes in heat, even if not thirsty.",
                "Micro-sleeps last 1-10 s - at 10 km/h that is 28 m travelled blind. Take breaks when drowsy."],
     "quiz": [{"q": "In heat, drink water...", "options": ["Only at lunch", "Every 30 minutes"], "answer": 1}]},
]


def recommend_training(summary, fc, safety_events, completed_ids):
    """Personalized: the operator's OWN behaviour + today's conditions drive the list."""
    recs = {}
    if summary.get("unfastened"):
        recs["seatbelt"] = f"You had {summary['unfastened']} seatbelt-unfastened events in your recent shifts"
    if summary.get("excess_idle_events"):
        recs["idling"] = (f"{summary['excess_idle_events']} excessive-idle windows cost ₹{summary['idle_cost_inr']:,} "
                          f"in fuel")
    prox = sum(1 for e in safety_events if e["type"] == "proximity")
    if prox:
        recs["proximity"] = f"{prox} proximity alerts triggered on your machine"
    conds = {h["condition"] for h in fc}
    if "Rainy" in conds:
        recs["rain"] = "Rain is forecast today and you have trenching scheduled"
    if "Windy" in conds:
        recs["wind"] = "Strong wind is forecast during your shift"
    if max(h["heat_index"] for h in fc) >= 38 or any(e["type"] == "fatigue" for e in safety_events):
        recs["fatigue"] = "High heat index today / fatigue signs detected"
    out = []
    for m in TRAINING_MODULES:
        out.append({**m, "recommended": m["tag"] in recs and m["id"] not in completed_ids,
                    "reason": recs.get(m["tag"]), "completed": m["id"] in completed_ids})
    out.sort(key=lambda m: (not m["recommended"], m["completed"]))
    return out


def safety_score(summary, incidents, events, completed_count):
    """0-100 score with a transparent breakdown the operator can understand."""
    parts = [
        ("Seatbelt violations", -min(35, summary.get("unfastened", 0) * 3)),
        ("Excessive idling", -min(20, summary.get("excess_idle_events", 0) * 2)),
        ("Live safety alerts", -min(20, len(events) * 2)),
        # Reporting is REWARDED - punishing reports only hides them.
        ("Reports filed (safety culture)", min(10, len(incidents) * 2)),
        ("Training completed", min(20, completed_count * 5)),
    ]
    score = max(0, min(100, 100 + sum(p for _, p in parts)))
    grade = "A" if score >= 85 else "B" if score >= 70 else "C" if score >= 55 else "D"
    return {"score": score, "grade": grade,
            "breakdown": [{"label": l, "points": p} for l, p in parts if p]}
