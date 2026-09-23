"""Performance feedback loop: trend -> comparison -> goals -> coaching -> measured again."""
import datetime as dt

import pandas as pd

from .ml import DIESEL_INR_PER_L, confidence

IDLE_GOAL_MIN = 20


def _daily(records, since):
    df = pd.DataFrame(records)
    df["date"] = df.timestamp.str[:10]
    df = df[df.date >= since]
    out = []
    for date, d in df.groupby("date"):
        n = len(d)
        unf = int((d.seatbelt == "Unfastened").sum())
        excess = int((d.idling_min > 45).sum())
        out.append({
            "date": date, "source": "telemetry",
            "score": max(0, 100 - unf * 8 - excess * 5),
            "idle_avg": round(float(d.idling_min.mean()), 1),
            "belt_pct": round(100 * (1 - unf / n)),
            "cycles": round(float(d.load_cycles.mean()), 1),
            "idle_cost": int(d.idle_cost_inr.sum()),
            "anomalies": int(d.anomaly.sum()),
        })
    return out


def _avg(days, key):
    vals = [d[key] for d in days if d.get(key) is not None]
    return round(sum(vals) / len(vals), 1) if vals else None


METRICS = [  # key, label, unit, higher_is_better
    ("score", "Daily safety score", "", True),
    ("idle_avg", "Idle per 2-h window", "min", False),
    ("belt_pct", "Seatbelt compliance", "%", True),
    ("cycles", "Load cycles per window", "", True),
    ("idle_cost", "Idle fuel cost / day", "₹", False),
]


def build(op, records, fleet_records, today_events, today_tasks, training_log, modules, mae_history):
    today = dt.date.today()
    since = str(today - dt.timedelta(days=14))
    days = _daily(records, since)

    # Live point for today: what happened in THIS shift (events + completed tasks).
    live = None
    if today_events or today_tasks:
        c = {t: sum(1 for e in today_events if e["type"] == t) for t in ("seatbelt", "fatigue", "proximity")}
        live = {"date": str(today), "source": "live",
                "score": max(0, 100 - c["seatbelt"] * 8 - c["fatigue"] * 6 - c["proximity"] * 3),
                "idle_avg": None, "belt_pct": None, "cycles": None, "idle_cost": None, "anomalies": None,
                "events": c}
        days = days + [live]

    tel_days = [d for d in days if d["source"] == "telemetry"]
    last, prev = tel_days[-7:], tel_days[-14:-7]
    comparison = []
    for key, label, unit, higher in METRICS:
        a, b = _avg(prev, key), _avg(last, key)
        if a is None or b is None:
            continue
        delta = (b - a) / a * 100 if a else 0
        comparison.append({"key": key, "label": label, "unit": unit, "prev": a, "curr": b,
                           "delta_pct": round(delta, 1), "better": (delta > 0) == higher if abs(delta) >= 1 else None})
    cmp = {c["key"]: c for c in comparison}

    fleet_cycles = round(float(pd.DataFrame(fleet_records).load_cycles.mean()), 1)
    done_modules = {x["module_id"] for x in training_log}
    rec_modules = [m for m in modules if m["reason"]]
    goals = [
        {"label": f"Idle ≤ {IDLE_GOAL_MIN} min per window", "current": f"{cmp['idle_avg']['curr']} min",
         "progress": min(1, IDLE_GOAL_MIN / max(cmp["idle_avg"]["curr"], 1))},
        {"label": "100% seatbelt compliance", "current": f"{cmp['belt_pct']['curr']}%",
         "progress": cmp["belt_pct"]["curr"] / 100},
        {"label": f"Load cycles ≥ fleet avg ({fleet_cycles})", "current": f"{cmp['cycles']['curr']}",
         "progress": min(1, cmp["cycles"]["curr"] / fleet_cycles)},
        {"label": "Finish recommended training", "current": f"{len(done_modules & {m['id'] for m in rec_modules})}/{len(rec_modules)}",
         "progress": (len(done_modules & {m['id'] for m in rec_modules}) / len(rec_modules)) if rec_modules else 1},
    ]

    # Prediction feedback: how the operator performed vs the AI's prediction today.
    pred_fb = [{"task_type": t["task_type"], "predicted_min": t["predicted_min"], "actual_min": t["actual_min"],
                "diff_pct": round((t["actual_min"] - t["predicted_min"]) / t["predicted_min"] * 100, 1)}
               for t in today_tasks if t.get("predicted_min")]

    coach = []
    idle = cmp["idle_avg"]
    if idle["better"]:
        saved = (idle["prev"] - idle["curr"]) * 4 * 7 / 60 * 3.5 * DIESEL_INR_PER_L
        coach.append({"kind": "win", "text": f"Idle time down {abs(idle['delta_pct']):.0f}% vs last week "
                      f"({idle['prev']} → {idle['curr']} min per window), about ₹{saved:,.0f} saved per week."})
    elif idle["curr"] > IDLE_GOAL_MIN:
        coach.append({"kind": "fix", "text": f"Idle averages {idle['curr']} min per 2-h window (goal {IDLE_GOAL_MIN}). "
                      "Shut down during waits longer than 5 min.", "module": "M2"})
    belt = cmp["belt_pct"]
    if belt["curr"] < 100:
        trend = " Better than last week. Keep going." if belt["better"] else " This is worse than last week." if belt["better"] is False else ""
        coach.append({"kind": "fix", "text": f"Seatbelt compliance is {belt['curr']}% this week (was {belt['prev']}%).{trend}",
                      "module": "M1"})
    else:
        coach.append({"kind": "win", "text": "100% seatbelt compliance this week."})
    cyc = cmp["cycles"]
    if cyc["curr"] >= fleet_cycles:
        coach.append({"kind": "win", "text": f"Productivity {cyc['curr']} load cycles per window, above fleet average {fleet_cycles}."})
    else:
        coach.append({"kind": "tip", "text": f"Productivity {cyc['curr']} load cycles per window vs fleet {fleet_cycles}. "
                      "Most of the gap comes from idle windows."})
    if pred_fb:
        avg = sum(p["diff_pct"] for p in pred_fb) / len(pred_fb)
        if avg <= -3:
            coach.append({"kind": "win", "text": f"Today you finished tasks {abs(avg):.0f}% faster than the AI predicted."})
        elif avg >= 8:
            coach.append({"kind": "tip", "text": f"Tasks today took {avg:.0f}% longer than predicted. Check for waiting on dumpers or re-work."})
    def n(k, word):
        return f"{k} {word}{'s' if k != 1 else ''}"
    if live and live["events"]["fatigue"]:
        coach.append({"kind": "fix", "text": f"{n(live['events']['fatigue'], 'fatigue alert')} this shift. "
                      "Take a 10-min break every 2 hours.", "module": "M6"})
    if live and live["events"]["seatbelt"]:
        coach.append({"kind": "fix", "text": f"{n(live['events']['seatbelt'], 'seatbelt escalation')} today.", "module": "M1"})

    wins = sum(1 for c in comparison if c["better"])
    conf = confidence(0.55 + 0.28 * min(1, len(tel_days) / 14) + (0.05 if live else 0),
                      "Daily aggregation of telemetry + live shift events, week-over-week comparison",
                      [f"{len(tel_days)} days of telemetry ({sum(1 for _ in records)} windows)",
                       "Today's point uses live alerts and completed tasks" if live else "No live activity yet today",
                       f"{len(mae_history)} model retraining snapshots"],
                      ["Daily score is a simple weighted count, not a validated risk model",
                       "Week-over-week changes on few days can be noise"])
    return {
        "days": days, "comparison": comparison, "wins": wins, "goals": goals, "coach": coach,
        "prediction_feedback": pred_fb, "training_log": training_log,
        "model_history": mae_history, "fleet_cycles": fleet_cycles, "confidence": conf,
    }
