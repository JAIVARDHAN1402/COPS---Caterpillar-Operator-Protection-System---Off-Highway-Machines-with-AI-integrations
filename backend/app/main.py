"""COPS (Caterpillar Operator Protection System) - API."""
import datetime as dt
import json
import os
import threading

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import domain, performance, shift
from .data_gen import DATA_DIR, SKILLS, TASK_BASE_MIN, WEATHERS, ensure_data, generate_tasks
from .ml import AnomalyDetector, TimePredictor, confidence

app = FastAPI(title="COPS API: Caterpillar Operator Protection System")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

TASKS_CSV, TEL_CSV = ensure_data()
STATE_PATH = DATA_DIR / "state.json"
STATE_VERSION = 2
lock = threading.RLock()

predictor = TimePredictor()
predictor.fit(pd.read_csv(TASKS_CSV))
telemetry = pd.read_csv(TEL_CSV)
detector = AnomalyDetector().fit(telemetry)


# ------------------------------------------------------------------ state
def empty_state():
    return {"version": STATE_VERSION, "day": None, "statuses": {}, "sessions": {}, "handovers": [],
            "incidents": [], "events": [], "training": {}, "training_log": [], "xp_bonus": {}}


_state = None  # in-memory source of truth; disk is only a backup across restarts


def load_state():
    global _state
    if _state is None:
        _state = empty_state()
        try:
            s = json.loads(STATE_PATH.read_text())
            if s.get("version") == STATE_VERSION:
                _state = s
        except (OSError, ValueError):
            pass
    return _state


def save_state(s):
    """Atomic write (temp file + replace) so a reader never sees a half-written file.
    OneDrive can briefly lock the file; the in-memory state stays correct either way."""
    global _state
    _state = s
    tmp = STATE_PATH.with_suffix(".tmp")
    try:
        tmp.write_text(json.dumps(s, indent=2))
        os.replace(tmp, STATE_PATH)
    except OSError:
        pass


def state():
    with lock:
        s = load_state()
        today = str(dt.date.today())
        if s.get("day") != today:  # new day -> fresh shift
            s.update(day=today, statuses={}, sessions={}, handovers=[])
            save_state(s)
        return s


def now_iso():
    return dt.datetime.now().isoformat(timespec="seconds")


def get_op(op_id):
    if op_id not in domain.OPERATORS:
        raise HTTPException(404, f"Unknown operator ID {op_id}")
    return domain.OPERATORS[op_id]


def get_machine(mid):
    if mid not in domain.MACHINES:
        raise HTTPException(404, f"Unknown machine {mid}")
    return domain.MACHINES[mid]


def op_profile(op_id, s):
    op = get_op(op_id)
    xp = op["xp"] + s["xp_bonus"].get(op_id, 0)
    skill, next_at = domain.skill_from_xp(xp)
    return {**op, **domain.MACHINES[op["machine_id"]], "xp": xp, "skill": skill, "next_level_xp": next_at}


def op_records(op_id):
    return detector.analyze(telemetry[telemetry.operator_id == op_id])


def op_summary(op_id):
    recs = op_records(op_id)
    return recs, AnomalyDetector.summarize(recs)


def machine_plan(s, mid, skill):
    m = get_machine(mid)
    return domain.plan_day(predictor, skill, m["machine_age"], s["statuses"].get(mid, {}), domain.forecast())


def today_events(s, op_id):
    return [e for e in s["events"] if e["operator_id"] == op_id and e["time"][:10] == s["day"]]


# ------------------------------------------------------------------ operators
@app.get("/api/operators")
def operators():
    s = state()
    return [op_profile(o, s) for o in domain.OPERATORS]


@app.get("/api/operators/{op_id}")
def operator(op_id: str):
    s = state()
    prof = op_profile(op_id, s)
    _, summary = op_summary(op_id)
    incidents = [i for i in s["incidents"] if i["operator_id"] == op_id]
    events = [e for e in s["events"] if e["operator_id"] == op_id]
    done = s["training"].get(op_id, [])
    safety = domain.safety_score(summary, incidents, events, len(done))
    safety["confidence"] = confidence(
        0.7 + 0.2 * min(1, summary["records"] / 50),
        "Transparent points system (not a black box)",
        [f"{summary['records']} telemetry windows", f"{len(events)} live safety events", f"{len(done)} lessons completed"],
        ["Weights are expert-set, not learned from accident data"])
    return {**prof, "safety": safety}


# ------------------------------------------------------------------ shift / handover
class PunchIn(BaseModel):
    operator_id: str
    machine_id: str | None = None


@app.get("/api/shift/pending")
def pending_handovers():
    s = state()
    return [{"id": h["id"], "machine_id": h["machine_id"], "from": domain.OPERATORS[h["from_operator"]]["name"],
             "reason": h["reason"], "created": h["created"]}
            for h in s["handovers"] if h["status"] == "pending"]


def brief_for(s, h, incoming_id):
    incoming = op_profile(incoming_id, s)
    # Frozen snapshot from handover time: work done afterwards never changes the briefing.
    before = h.get("snapshot", s["statuses"].get(h["machine_id"], {}))
    m = get_machine(h["machine_id"])
    plan, _ = domain.plan_day(predictor, incoming["skill"], m["machine_age"], before, domain.forecast())
    events = [e for e in s["events"] if e["operator_id"] == h["from_operator"] and e["time"][:10] == s["day"]]
    incidents = [i for i in s["incidents"] if i["operator_id"] == h["from_operator"] and i["time"][:10] == s["day"]]
    last = telemetry[telemetry.machine_id == h["machine_id"]].tail(1).to_dict("records")
    return shift.build_brief(h, plan, incoming, events, incidents, domain.forecast(), last[0] if last else {})


@app.post("/api/shift/punch-in")
def punch_in(body: PunchIn):
    op_id = body.operator_id.strip().upper()
    get_op(op_id)
    with lock:
        s = state()
        pending = [h for h in s["handovers"] if h["status"] == "pending"
                   and (body.machine_id is None or h["machine_id"] == body.machine_id)
                   and h["from_operator"] != op_id]
        h = pending[-1] if pending else None
        mid = h["machine_id"] if h else (body.machine_id or domain.OPERATORS[op_id]["machine_id"])
        get_machine(mid)
        for m, sess in list(s["sessions"].items()):  # an operator runs one machine at a time
            if sess["operator_id"] == op_id:
                del s["sessions"][m]
        s["sessions"][mid] = {"operator_id": op_id, "since": now_iso(), "handover_id": h and h["id"]}
        save_state(s)
    return {"operator": op_profile(op_id, s), "machine": domain.MACHINES[mid],
            "session": s["sessions"][mid], "handover": brief_for(s, h, op_id) if h else None}


class HandoverIn(BaseModel):
    operator_id: str
    machine_id: str
    reason: str
    note: str = ""
    progress: float = 0.5  # how far the in-progress task got (reported by operator)


@app.post("/api/shift/handover")
def create_handover(body: HandoverIn):
    get_op(body.operator_id)
    get_machine(body.machine_id)
    with lock:
        s = state()
        sts = s["statuses"].setdefault(body.machine_id, {})
        for st in sts.values():
            if st.get("status") in ("in_progress", "paused"):
                st.update(status="paused", progress=max(0.0, min(0.99, body.progress)))
        prof = op_profile(body.operator_id, s)
        plan, _ = machine_plan(s, body.machine_id, prof["skill"])
        h = {"id": f"HO{len(s['handovers']) + 1:03d}", "machine_id": body.machine_id,
             "from_operator": body.operator_id, "reason": body.reason, "note": body.note.strip(),
             "created": now_iso(), "status": "pending", "handover_min": shift.worked_until(plan),
             "snapshot": json.loads(json.dumps(sts))}
        s["handovers"].append(h)
        s["sessions"].pop(body.machine_id, None)
        save_state(s)
    return h


class AckIn(BaseModel):
    operator_id: str


@app.post("/api/shift/handover/{hid}/ack")
def ack_handover(hid: str, body: AckIn):
    with lock:
        s = state()
        h = next((x for x in s["handovers"] if x["id"] == hid), None)
        if not h:
            raise HTTPException(404, "Unknown handover")
        h.update(status="acknowledged", acknowledged_by=body.operator_id, acknowledged_at=now_iso())
        save_state(s)
    return {"ok": True}


@app.get("/api/shift/handover/{hid}")
def get_handover(hid: str, operator_id: str):
    s = state()
    h = next((x for x in s["handovers"] if x["id"] == hid), None)
    if not h:
        raise HTTPException(404, "Unknown handover")
    return brief_for(s, h, operator_id)


@app.get("/api/shift/reasons")
def reasons():
    return shift.HANDOVER_REASONS


# ------------------------------------------------------------------ schedule & tasks
@app.get("/api/schedule/{op_id}")
def schedule(op_id: str, machine_id: str | None = None):
    s = state()
    prof = op_profile(op_id, s)
    mid = machine_id or prof["machine_id"]
    m = get_machine(mid)
    fc = domain.forecast()
    plan, naive_risky = machine_plan(s, mid, prof["skill"])
    for p in plan:
        p["done_by_name"] = domain.OPERATORS.get(p["done_by"], {}).get("name")
    naive_total = sum(TASK_BASE_MIN[t["task_type"]] for t in plan)
    pred_total = sum(t["prediction"]["predicted_min"] for t in plan)
    task_conf = sum(p["prediction"]["confidence"]["score"] for p in plan) / len(plan)
    rainy_or_windy = sum(1 for h in fc if h["condition"] in ("Rainy", "Windy"))
    sched_conf = confidence(
        task_conf * 0.6 + 0.35,
        "Exhaustive search over all 120 task orders × hourly forecast × ML durations",
        [f"Average task-time confidence {task_conf:.0%}",
         f"{rainy_or_windy} forecast hours with rain/wind considered",
         f"{naive_risky} tasks in the original order hit risky weather"],
        ["Weather forecast is simulated; real forecasts get less certain further ahead",
         "Assumes 10 min repositioning between tasks"])
    session = s["sessions"].get(mid, {})
    handover = next((h for h in reversed(s["handovers"]) if h["machine_id"] == mid), None)
    return {"date": s["day"], "skill": prof["skill"], "machine": m, "tasks": plan, "forecast": fc,
            "shift": {"start": domain.fmt(domain.SHIFT_START_MIN), "end": domain.fmt(domain.SHIFT_END_MIN)},
            "site_estimate_total": naive_total, "predicted_total": round(pred_total),
            "naive_risky_tasks": naive_risky, "planned_risky_tasks": sum(1 for t in plan if t["risk"] != "low"),
            "confidence": sched_conf,
            "handover": handover and {"id": handover["id"], "from_id": handover["from_operator"],
                                      "from": domain.OPERATORS[handover["from_operator"]]["name"],
                                      "at": domain.fmt(handover["handover_min"]), "reason": handover["reason"],
                                      "status": handover["status"]},
            "session_operator": session.get("operator_id")}


class StartIn(BaseModel):
    operator_id: str
    seatbelt: str = "Fastened"


@app.post("/api/machines/{mid}/tasks/{task_id}/start")
def start_task(mid: str, task_id: str, body: StartIn):
    get_machine(mid)
    if body.seatbelt != "Fastened":
        raise HTTPException(423, "Interlock: fasten seatbelt before starting a task")
    with lock:
        s = state()
        sts = s["statuses"].setdefault(mid, {})
        for st in sts.values():  # only one task in progress at a time
            if st.get("status") == "in_progress":
                st["status"] = "paused"
        prev = sts.get(task_id, {})
        sts[task_id] = {**prev, "status": "in_progress", "operator_id": body.operator_id,
                        "started_at": prev.get("started_at") or now_iso()}
        save_state(s)
    return {"ok": True}


class CompleteIn(BaseModel):
    operator_id: str
    actual_min: float | None = None


@app.post("/api/machines/{mid}/tasks/{task_id}/complete")
def complete_task(mid: str, task_id: str, body: CompleteIn):
    """Completing a task feeds the model: it retrains on the new ground truth."""
    m = get_machine(mid)
    with lock:
        s = state()
        prof = op_profile(body.operator_id, s)
        plan, _ = machine_plan(s, mid, prof["skill"])
        item = next(p for p in plan if p["task_id"] == task_id)
        st = s["statuses"].setdefault(mid, {}).setdefault(task_id, {})
        actual = round(max(1.0, body.actual_min or item["prediction"]["predicted_min"]), 1)
        st.update(status="done", actual_min=actual, operator_id=body.operator_id,
                  predicted_min=item["prediction"]["predicted_min"], task_type=item["task_type"],
                  completed_at=now_iso(), progress=1)
        save_state(s)

        hist = pd.read_csv(TASKS_CSV)
        row = {"task_id": f"L{len(hist)}", "task_type": item["task_type"], "weather": item["weather"],
               "operator_skill": prof["skill"], "machine_age": m["machine_age"],
               "estimated_min": TASK_BASE_MIN[item["task_type"]], "actual_min": actual}
        hist = pd.concat([hist, pd.DataFrame([row])], ignore_index=True)
        hist.to_csv(TASKS_CSV, index=False)
        stats = predictor.fit(hist)
    return {"ok": True, "actual_min": actual, "model": stats}


class PredictIn(BaseModel):
    task_type: str
    weather: str
    operator_skill: str
    machine_age: int


@app.post("/api/predict")
def predict(body: PredictIn):
    if body.task_type not in TASK_BASE_MIN or body.weather not in WEATHERS or body.operator_skill not in SKILLS:
        raise HTTPException(400, "Invalid input")
    return predictor.predict(body.task_type, body.weather, body.operator_skill, body.machine_age)


@app.get("/api/model/stats")
def model_stats():
    return {**predictor.stats, "task_types": list(TASK_BASE_MIN), "weathers": WEATHERS, "skills": SKILLS,
            "confidence": confidence(
                1 - predictor.stats["mae"] / 30,
                "Held-out test split (20%) after every retrain",
                [f"Error ±{predictor.stats['mae']} min vs ±{predictor.stats['baseline_mae']} for static estimates",
                 f"{predictor.stats['samples']} training tasks"],
                ["Most training data is synthetic, calibrated on 5 real rows"])}


@app.get("/api/insights/{op_id}")
def insights(op_id: str):
    get_op(op_id)
    recs, summary = op_summary(op_id)
    fleet = AnomalyDetector.summarize(detector.analyze(telemetry))
    return {"records": recs, "summary": summary, "fleet": fleet, "confidence": summary["confidence"]}


@app.get("/api/performance/{op_id}")
def perf(op_id: str):
    s = state()
    get_op(op_id)
    tasks_today = [st for sts in s["statuses"].values() for st in sts.values()
                   if st.get("operator_id") == op_id and st.get("status") == "done"]
    _, summary = op_summary(op_id)
    modules = domain.recommend_training(summary, domain.forecast(), today_events(s, op_id), s["training"].get(op_id, []))
    return performance.build(
        op_profile(op_id, s), op_records(op_id), detector.analyze(telemetry), today_events(s, op_id), tasks_today,
        [x for x in s["training_log"] if x["operator_id"] == op_id], modules, predictor.mae_history)


# ------------------------------------------------------------------ safety
class EventIn(BaseModel):
    operator_id: str
    type: str          # seatbelt | proximity | fatigue
    detail: str = ""
    machine_id: str | None = None


@app.post("/api/safety/events")
def log_event(body: EventIn):
    with lock:
        s = state()
        e = {**body.model_dump(), "time": now_iso()}
        s["events"].append(e)
        s["events"] = s["events"][-500:]
        save_state(s)
    return e


@app.get("/api/safety/events/{op_id}")
def list_events(op_id: str):
    return [e for e in state()["events"] if e["operator_id"] == op_id][-50:][::-1]


class ParseIn(BaseModel):
    text: str


@app.post("/api/incidents/parse")
def parse_incident(body: ParseIn):
    return domain.parse_incident(body.text)


class IncidentIn(BaseModel):
    operator_id: str
    description: str
    primary_type: str
    severity: str
    location: str
    persons_involved: bool = False
    source: str = "manual"
    machine_id: str | None = None


@app.post("/api/incidents")
def create_incident(body: IncidentIn):
    op = get_op(body.operator_id)
    mid = body.machine_id or op["machine_id"]
    # "Black box": attach the machine's latest telemetry to the report.
    snap = telemetry[telemetry.machine_id == mid].tail(3).to_dict("records")
    with lock:
        s = state()
        inc = {**body.model_dump(), "id": f"INC{len(s['incidents']) + 1:04d}", "machine_id": mid,
               "time": now_iso(), "telemetry_snapshot": snap, "status": "Open"}
        s["incidents"].append(inc)
        save_state(s)
    return inc


@app.get("/api/incidents")
def list_incidents(operator_id: str | None = None):
    inc = state()["incidents"]
    if operator_id:
        inc = [i for i in inc if i["operator_id"] == operator_id]
    return inc[::-1]


# ------------------------------------------------------------------ training
@app.get("/api/training/{op_id}")
def training(op_id: str):
    get_op(op_id)
    s = state()
    _, summary = op_summary(op_id)
    events = [e for e in s["events"] if e["operator_id"] == op_id]
    mods = domain.recommend_training(summary, domain.forecast(), events, s["training"].get(op_id, []))
    evidence = sum(1 for m in mods if m["reason"])
    return {"modules": mods, "confidence": confidence(
        0.6 + 0.05 * min(evidence, 5), "Rules linking your own telemetry, live alerts and today's forecast to lessons",
        [f"{evidence} lessons backed by specific evidence from your data",
         f"{summary['unfastened']} seatbelt and {summary['excess_idle_events']} idle events analysed"],
        ["Recommendations are rule-based, not learned from training outcomes yet"])}


class TrainingDoneIn(BaseModel):
    module_id: str
    score: float  # 0..1


@app.post("/api/training/{op_id}/complete")
def training_done(op_id: str, body: TrainingDoneIn):
    before = op_profile(op_id, state())
    module = next((m for m in domain.TRAINING_MODULES if m["id"] == body.module_id), None)
    if not module:
        raise HTTPException(404, "Unknown module")
    passed = body.score >= 0.5
    with lock:
        s = state()
        done = s["training"].setdefault(op_id, [])
        gained = 0
        if passed and body.module_id not in done:
            done.append(body.module_id)
            gained = module["xp"]
            s["xp_bonus"][op_id] = s["xp_bonus"].get(op_id, 0) + gained
            s["training_log"].append({"operator_id": op_id, "module_id": module["id"], "title": module["title"],
                                      "score": body.score, "xp": gained, "time": now_iso()})
        save_state(s)
    after = op_profile(op_id, state())
    return {"passed": passed, "xp_gained": gained, "xp": after["xp"],
            "skill_before": before["skill"], "skill_after": after["skill"],
            "leveled_up": before["skill"] != after["skill"]}


@app.post("/api/demo/reset")
def reset_demo():
    """Reset live state + learned task history for a clean, repeatable demo run."""
    with lock:
        save_state(empty_state())
        base = generate_tasks()
        base.to_csv(TASKS_CSV, index=False)
        predictor.mae_history.clear()
        predictor.fit(base)
    return {"ok": True}
