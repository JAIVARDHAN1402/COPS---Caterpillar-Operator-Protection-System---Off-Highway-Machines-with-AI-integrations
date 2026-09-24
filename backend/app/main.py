"""COPS (Caterpillar Operator Protection System) - API."""
import datetime as dt
import json
import math
import os
import threading

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import assistant, domain, performance, shift
from .health import FAULTS, META, HealthRegistry
from .sms import Notifier
from .data_gen import DATA_DIR, SKILLS, TASK_BASE_MIN, WEATHERS, ensure_data, generate_tasks
from .ml import AnomalyDetector, TimePredictor, confidence

app = FastAPI(title="COPS API: Caterpillar Operator Protection System")
assistant.warm_up()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

TASKS_CSV, TEL_CSV = ensure_data()
STATE_PATH = DATA_DIR / "state.json"
STATE_VERSION = 2
lock = threading.RLock()

predictor = TimePredictor()
predictor.fit(pd.read_csv(TASKS_CSV))
telemetry = pd.read_csv(TEL_CSV)
detector = AnomalyDetector().fit(telemetry)
health = HealthRegistry(domain.MACHINES)
sms = Notifier()
IDLE_ALERT_S = int(os.environ.get("COPS_IDLE_ALERT_S", "60"))   # demo: 60 s (a real site might use 10 min)
DIESEL_INR = 92.0
CO2_PER_L = 2.68
_anomalies_seen = {}
_idle_alerted = set()


# ------------------------------------------------------------------ state
def empty_state():
    return {"version": STATE_VERSION, "day": None, "statuses": {}, "sessions": {}, "handovers": [],
            "incidents": [], "events": [], "training": {}, "training_log": [], "xp_bonus": {},
            "sos": [], "blackbox": []}


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
        s.setdefault("sos", [])
        s.setdefault("blackbox", [])
        return s


def now_iso():
    return dt.datetime.now().isoformat(timespec="seconds")


def alert_supervisor(mid, op_id, headline, reason="", severity="HIGH", action=None, key=None, kind="alert", extra=None,
                     whatsapp=False, skip_latest=False):
    """Compose the supervisor alert: what happened, why, who, when, what to do, and the recent timeline.
    SMS always; WhatsApp too for high-risk situations (whatsapp=True)."""
    m = domain.MACHINES.get(mid, {})
    op = domain.OPERATORS.get(op_id, {})
    now = dt.datetime.now()
    end = lambda t: t if not t or t.endswith((".", "!", "?")) else t + "."  # noqa: E731
    parts = [f"COPS ALERT [{severity}] {mid} {m.get('machine', '')}: {headline}.",
             end(f"Reason: {reason}") if reason else "",
             f"Operator: {op.get('name', op_id)} ({op_id}). Time {now:%H:%M}.",
             end(extra or ""),
             end(f"Action: {action}") if action else ""]
    base = " ".join(x for x in parts if x)

    # "What happened": the other recent events on this machine, newest first, fitted into the space left
    cutoff = (now - dt.timedelta(minutes=15)).isoformat(timespec="seconds")
    recent = [e for e in state()["events"] if e.get("machine_id") == mid and e["time"] >= cutoff
              and not (reason and (e["detail"] in reason or reason in e["detail"]))]
    if skip_latest and recent:  # the event that triggered this alert was just logged: don't repeat it
        recent = recent[:-1]
    items = [f"{e['time'][11:16]} {e['detail'][:60]}" for e in reversed(recent[-5:])]
    room = 480 - len(base) - len(" Before this: .")
    kept = []
    for it in items:
        if sum(len(k) + 2 for k in kept) + len(it) > room:
            break
        kept.append(it)
    text = base + (f" Before this: {'; '.join(kept)}." if kept else "")

    icon = {"CRITICAL": "🚨", "HIGH": "⚠️", "MEDIUM": "🔔"}.get(severity, "ℹ️")
    wa = [f"{icon} *COPS {severity}: {headline}*",
          f"🚜 {mid} · {m.get('machine', '')}",
          f"👷 {op.get('name', op_id)} ({op_id})",
          f"🕒 {now:%d %b, %H:%M}"]
    if reason:
        wa.append(f"❗ *Reason:* {reason}")
    if extra:
        wa.append(extra)
    if action:
        wa.append(f"➡️ *Action:* {action}")
    if kept:
        wa.append("📜 *Before this:*\n" + "\n".join(f"• {k}" for k in kept))
    wa.append("_Open the COPS Supervisor Console to acknowledge._")
    return sms.send(text, severity=severity, key=key, kind=kind, channels=("sms", "whatsapp") if whatsapp else ("sms",),
                    wa_text="\n".join(wa), machine_id=mid)


def alert_for_event(e):
    """Every safety discrepancy logged by the cab becomes a supervisor SMS (deduplicated)."""
    t, d, op = e["type"], e.get("detail", ""), e["operator_id"]
    mid = e.get("machine_id") or domain.OPERATORS.get(op, {}).get("machine_id")
    if t == "seatbelt":
        if "blocked" in d.lower():
            alert_supervisor(mid, op, "Engine start attempted without seatbelt", d, "MEDIUM",
                             "Remind the operator: belt on before starting.", key=f"belt-block:{mid}")
        else:
            alert_supervisor(mid, op, "Seatbelt removed while engine running", d, "HIGH",
                             "Call the operator; no work until belted.", key=f"belt:{mid}")
    elif t == "proximity":
        alert_supervisor(mid, op, "Person entered the machine danger zone", d, "HIGH",
                         "Check the site; enforce the 3 m exclusion zone.", key=f"prox:{mid}")
    elif t == "fatigue":
        if "microsleep" in d.lower():
            alert_supervisor(mid, op, "Operator MICROSLEEP detected", d, "CRITICAL",
                             "Stop the machine and relieve the operator.", key=f"micro:{mid}", whatsapp=True)
        else:
            alert_supervisor(mid, op, "Operator fatigue signs", d, "MEDIUM", "Arrange a 10-min break.", key=f"fatigue:{mid}")
    elif t == "man_down":
        alert_supervisor(mid, op, "Tilt/impact event (operator confirmed OK)", d, "MEDIUM",
                         "Inspect the machine and ground stability.", key=f"mandown:{mid}")


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
        if not body.reason.lower().startswith("planned"):
            alert_supervisor(body.machine_id, body.operator_id, "Operator left mid-shift", body.reason, "HIGH",
                             "Assign a replacement; they must read the handover briefing.", key=f"ho:{h['id']}", kind="handover",
                             extra=f"Work stopped at {domain.fmt(h['handover_min'])}." + (f" Note: {h['note']}" if h["note"] else ""))
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
        if st.get("status") == "done":  # double click / retry: don't log the task twice
            return {"ok": True, "actual_min": st["actual_min"], "model": predictor.stats, "retraining": False, "duplicate": True}
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
    # Retraining takes a few seconds: answer the operator now, learn in the background.
    threading.Thread(target=retrain_in_background, daemon=True).start()
    return {"ok": True, "actual_min": actual, "model": predictor.stats, "retraining": True}


_retrain_lock = threading.Lock()
_retraining = {"active": False}


def retrain_in_background():
    """Serialised: overlapping completions each trigger one retrain on the latest CSV."""
    with _retrain_lock:
        _retraining["active"] = True
        try:
            predictor.fit(pd.read_csv(TASKS_CSV))
        finally:
            _retraining["active"] = False


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
    return {**predictor.stats, "retraining": _retraining["active"],
            "task_types": list(TASK_BASE_MIN), "weathers": WEATHERS, "skills": SKILLS,
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
        alert_for_event(e)
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
        sev = {"Low": "MEDIUM", "Medium": "HIGH", "High": "HIGH", "Critical": "CRITICAL"}.get(body.severity, "HIGH")
        alert_supervisor(mid, body.operator_id, f"Incident reported: {body.primary_type} ({body.severity})",
                         body.description[:140], sev, "Review the incident and black-box replay in the Supervisor Console.",
                         key=f"inc:{inc['id']}", kind="incident", extra=f"Location: {body.location}.")
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


# ------------------------------------------------------------------ machine health (runtime monitoring)
def health_report(mid):
    """Advance the sensor model, log new warn/critical transitions as safety events."""
    get_machine(mid)
    with lock:
        r = health.get(mid).report()
        if r["transitions"]:
            s = state()
            op = s["sessions"].get(mid, {}).get("operator_id", "SYSTEM")
            for t in r["transitions"]:
                s["events"].append({"operator_id": op, "machine_id": mid, "type": "health", "time": now_iso(),
                                    "detail": f"{t['label']} {t['status'].upper()}: {t['value']}{t['unit']}"})
            s["events"] = s["events"][-500:]
            save_state(s)
            for t in r["transitions"]:
                crit = t["status"] == "crit"
                alert_supervisor(mid, op, f"{t['label']} {'CRITICAL' if crit else 'warning'} ({t['value']}{t['unit']})",
                                 "Machine health sensor out of range", "CRITICAL" if crit else "MEDIUM",
                                 META[t["key"]]["action"], key=f"health:{mid}:{t['key']}:{t['status']}", kind="health",
                                 whatsapp=crit)
        seen = _anomalies_seen.setdefault(mid, set())
        for a in r["anomalies"]:
            if a["key"] not in seen:
                op = state()["sessions"].get(mid, {}).get("operator_id", "SYSTEM")
                alert_supervisor(mid, op, a["title"], a["detail"], "HIGH", "Inspect before the next shift.",
                                 key=f"anom:{mid}:{a['key']}", kind="health")
        seen.intersection_update({a["key"] for a in r["anomalies"]})
        seen.update(a["key"] for a in r["anomalies"])
        idle_watchdog(mid, r["utilisation"])
    return r


def idle_watchdog(mid, u):
    """Engine running but no work: fuel is being wasted. Alert the supervisor on WhatsApp + SMS
    once per idle episode at IDLE_ALERT_S, and again at 3x if it's still idling."""
    idle = u["idle_now_s"]
    if not u["idle_since"] or idle < IDLE_ALERT_S:
        return
    episode = int(u["idle_since"])
    stage = 2 if idle >= 3 * IDLE_ALERT_S else 1
    key = f"idle:{mid}:{episode}:{stage}"
    if key in _idle_alerted:
        return
    _idle_alerted.add(key)
    s = state()
    op = s["sessions"].get(mid, {}).get("operator_id", "SYSTEM")
    wasted_l = u["idle_now_fuel_l"]  # same accumulator as the shift total, so it never exceeds it
    mins = f"{int(idle // 60)} min {int(idle % 60)} s"
    s["events"].append({"operator_id": op, "machine_id": mid, "type": "idle", "time": now_iso(),
                        "detail": f"Engine idling {mins} with no work (~{wasted_l:.2f} L diesel wasted)"})
    save_state(s)
    alert_supervisor(mid, op, ("Engine STILL idling" if stage == 2 else "Engine idling with NO WORK") + f" for {mins}",
                     "Engine running but no task in progress: fuel is being wasted", "HIGH",
                     "Call the operator: start work or shut the engine down if waiting more than 5 min.",
                     key=key, kind="idle", whatsapp=True, skip_latest=True,
                     extra=(f"⛽ Wasted this idle: {wasted_l:.2f} L (~₹{wasted_l * DIESEL_INR:.0f}, {wasted_l * CO2_PER_L:.1f} kg CO₂). "
                            f"Shift idle total: {u['idle_s'] // 60} min, {max(u['idle_fuel_l'], wasted_l):.2f} L."))


@app.get("/api/machines/{mid}/health")
def machine_health(mid: str):
    return health_report(mid)


class EngineIn(BaseModel):
    on: bool
    working: bool = False


@app.post("/api/machines/{mid}/engine")
def set_engine(mid: str, body: EngineIn):
    get_machine(mid)
    with lock:
        health.get(mid).set_engine(body.on, body.working)
    return health_report(mid)


class FaultIn(BaseModel):
    fault: str


@app.post("/api/machines/{mid}/health/fault")
def inject_fault(mid: str, body: FaultIn):
    """Demo control: simulate a leak, overheating, clogged filter..."""
    get_machine(mid)
    if body.fault not in FAULTS:
        raise HTTPException(400, f"Unknown fault. Options: {', '.join(FAULTS)}")
    with lock:
        health.get(mid).inject(body.fault)
    return health_report(mid)


class ServiceIn(BaseModel):
    what: str = "all"  # all | fluids | fuel | filter


@app.post("/api/machines/{mid}/health/service")
def service_machine(mid: str, body: ServiceIn):
    get_machine(mid)
    with lock:
        health.get(mid).service(body.what)
    return health_report(mid)


class StopIn(BaseModel):
    operator_id: str
    reason: str
    detail: str = ""
    task: str | None = None


@app.post("/api/machines/{mid}/stop")
def emergency_stop(mid: str, body: StopIn):
    """The cab shut the machine down mid-shift because of an incident: log it and SMS the supervisor."""
    get_machine(mid)
    with lock:
        health.get(mid).set_engine(False, False)
        s = state()
        e = {"operator_id": body.operator_id, "machine_id": mid, "type": "machine_stop", "time": now_iso(),
             "detail": f"EMERGENCY STOP: {body.reason}"}
        s["events"].append(e)
        save_state(s)
        entry = alert_supervisor(mid, body.operator_id, "MACHINE STOPPED mid-shift (emergency stop)", body.reason, "CRITICAL",
                                 "Inspect the machine before restart; check on the operator.", key=f"stop:{mid}:{body.reason}",
                                 kind="machine_stop", extra=(f"Task interrupted: {body.task}. " if body.task else "") + (body.detail or ""),
                                 whatsapp=True)
    return {"ok": True, "sms": entry}


class SmsConfigIn(BaseModel):
    to: str


@app.get("/api/sms")
def sms_status():
    return {**sms.status(), "outbox": list(sms.outbox)[:30]}


@app.post("/api/sms/config")
def sms_config(body: SmsConfigIn):
    to = sms.set_recipients(body.to.split(","))
    if not to:
        raise HTTPException(400, "Enter a valid mobile number")
    return sms.status()


@app.post("/api/sms/test")
def sms_test(channel: str = "sms"):
    ch = ("whatsapp",) if channel == "whatsapp" else ("sms",)
    msg = f"COPS test alert: {'WhatsApp' if channel == 'whatsapp' else 'SMS'} alerts are working. Time {dt.datetime.now():%H:%M}."
    return sms.send(msg, severity="INFO", kind="test", channels=ch, wa_text="✅ *COPS test*\n" + msg)


# ------------------------------------------------------------------ SOS / man-down
class SosIn(BaseModel):
    operator_id: str
    machine_id: str
    type: str          # manual | voice | rollover | impact | missed_checkin
    detail: str = ""
    lat: float | None = None
    lon: float | None = None
    location_label: str = ""
    risk: str = "high"       # high -> supervisor at once (WhatsApp + SMS); manageable -> operator handles first
    category: str = ""


def sos_alert(sos, escalated=False):
    has_gps = sos.get("lat") is not None
    label = sos.get("location_label") or ("" if has_gps else "GPS not shared, machine's last known site")
    loc = f"📍 Location: {label}".rstrip() + (f" https://maps.google.com/?q={sos['lat']},{sos['lon']}" if has_gps else "")
    head = (f"ESCALATED SOS: operator could not resolve ({sos['category'] or sos['type'].replace('_', ' ')})" if escalated
            else f"HIGH-RISK SOS ({sos['category'] or sos['type'].replace('_', ' ')})")
    alert_supervisor(sos["machine_id"], sos["operator_id"], head, sos["detail"], "CRITICAL",
                     "Send help now and acknowledge in the COPS Supervisor Console.",
                     key=f"sos:{sos['id']}:{'esc' if escalated else 'new'}", kind="sos", extra=loc + ".", whatsapp=True,
                     skip_latest=True)


@app.post("/api/sos")
def raise_sos(body: SosIn):
    op = get_op(body.operator_id)
    get_machine(body.machine_id)
    with lock:
        s = state()
        risk = "manageable" if body.risk == "manageable" else "high"
        sos = {**body.model_dump(), "risk": risk, "id": f"SOS{len(s['sos']) + 1:03d}", "operator_name": op["name"],
               "time": now_iso(), "status": "active" if risk == "high" else "self_handling",
               "escalated": False, "acknowledged_by": None, "resolved_note": None}
        s["sos"].append(sos)
        s["events"].append({"operator_id": body.operator_id, "machine_id": body.machine_id, "type": "sos",
                            "time": now_iso(), "detail": f"SOS {risk.upper()} ({body.category or body.type}) {body.detail}".strip()})
        save_state(s)
        if risk == "high":
            sos_alert(sos)
    return sos


class EscalateIn(BaseModel):
    reason: str = "Not resolved by the operator in time"


@app.post("/api/sos/{sid}/escalate")
def escalate_sos(sid: str, body: EscalateIn):
    """A manageable SOS the operator couldn't fix becomes high-risk: WhatsApp + SMS to the supervisor."""
    with lock:
        sos = get_sos(sid)
        if sos["status"] == "self_handling":
            sos.update(status="active", risk="high", escalated=True, escalated_at=now_iso(),
                       detail=f"{sos['detail']} ({body.reason})".strip())
            state()["events"].append({"operator_id": sos["operator_id"], "machine_id": sos["machine_id"], "type": "sos",
                                      "time": now_iso(), "detail": f"SOS ESCALATED: {body.reason}"})
            save_state(state())
            sos_alert(sos, escalated=True)
    return sos


@app.get("/api/sos/{sid}")
def get_sos(sid: str):
    sos = next((x for x in state()["sos"] if x["id"] == sid), None)
    if not sos:
        raise HTTPException(404, "Unknown SOS")
    return sos


class SosUpdate(BaseModel):
    by: str = "Supervisor"
    note: str = ""


@app.post("/api/sos/{sid}/ack")
def ack_sos(sid: str, body: SosUpdate):
    with lock:
        sos = get_sos(sid)
        if sos["status"] == "active":
            sos.update(status="acknowledged", acknowledged_by=body.by, acknowledged_at=now_iso())
        save_state(state())
    return sos


@app.post("/api/sos/{sid}/resolve")
def resolve_sos(sid: str, body: SosUpdate):
    with lock:
        sos = get_sos(sid)
        sos.update(status="resolved", resolved_note=body.note or "Resolved", resolved_at=now_iso())
        save_state(state())
    return sos


# ------------------------------------------------------------------ black-box recordings
class BlackBoxIn(BaseModel):
    operator_id: str
    machine_id: str
    trigger: str
    detail: str = ""
    trigger_at: float           # epoch ms of the triggering moment
    frames: list[dict]          # ~4 frames/s of machine state, last ~60 s


@app.post("/api/blackbox")
def save_blackbox(body: BlackBoxIn):
    op = get_op(body.operator_id)
    with lock:
        s = state()
        rec = {**body.model_dump(), "frames": body.frames[-300:], "operator_name": op["name"],
               "id": f"BB{len(s['blackbox']) + 1:03d}", "time": now_iso()}
        s["blackbox"].append(rec)
        s["blackbox"] = s["blackbox"][-20:]
        save_state(s)
    return {k: rec[k] for k in ("id", "trigger", "time")}


@app.get("/api/blackbox")
def list_blackbox(machine_id: str | None = None):
    recs = [r for r in state()["blackbox"] if not machine_id or r["machine_id"] == machine_id]
    return [{k: r[k] for k in ("id", "trigger", "detail", "time", "operator_id", "operator_name", "machine_id")}
            | {"seconds": round((r["frames"][-1]["t"] - r["frames"][0]["t"]) / 1000) if r["frames"] else 0}
            for r in reversed(recs)]


@app.get("/api/blackbox/{bid}")
def get_blackbox(bid: str):
    rec = next((r for r in state()["blackbox"] if r["id"] == bid), None)
    if not rec:
        raise HTTPException(404, "Unknown recording")
    return rec


# ------------------------------------------------------------------ supervisor console
@app.get("/api/supervisor/overview")
def supervisor_overview():
    s = state()
    machines = []
    for mid, m in domain.MACHINES.items():
        sess = s["sessions"].get(mid, {})
        op = domain.OPERATORS.get(sess.get("operator_id"), {})
        machines.append({**m, "operator": op.get("name"), "operator_id": sess.get("operator_id"),
                         "health": health_report(mid)})
    return {
        "sos": [x for x in reversed(s["sos"]) if x["status"] != "resolved"],
        "sos_history": [x for x in reversed(s["sos"]) if x["status"] == "resolved"][:10],
        "machines": machines,
        "events": s["events"][-40:][::-1],
        "incidents": s["incidents"][-10:][::-1],
        "handovers": [h | {"from_name": domain.OPERATORS[h["from_operator"]]["name"]}
                      for h in s["handovers"] if h["status"] == "pending"],
        "blackbox": list_blackbox(),
        "sms": {**sms.status(), "outbox": list(sms.outbox)[:30]},
    }


# ------------------------------------------------------------------ shift report
def _hm(sec):
    sec = int(sec)
    return f"{sec // 3600}h {sec % 3600 // 60:02d}m" if sec >= 3600 else f"{sec // 60}m {sec % 60:02d}s"


@app.get("/api/shift-report/{op_id}")
def shift_report(op_id: str, machine_id: str | None = None):
    s = state()
    prof = op_profile(op_id, s)
    mid = machine_id or prof["machine_id"]
    m = get_machine(mid)
    day = s["day"]
    hr = health_report(mid)
    u = hr["utilisation"]
    sch = schedule(op_id, mid)
    events = [e for e in s["events"] if e["time"][:10] == day and (e.get("machine_id") == mid or e["operator_id"] == op_id)]
    sos_today = [x for x in s["sos"] if x["time"][:10] == day and x["machine_id"] == mid]
    incidents = [i for i in s["incidents"] if i["time"][:10] == day and i["machine_id"] == mid]
    notes = [n for n in sms.outbox if n.get("machine_id") == mid and n["time"][:10] == day]
    recs = [r for r in list_blackbox(mid) if r["time"][:10] == day]
    handovers = [h | {"from_name": domain.OPERATORS[h["from_operator"]]["name"]} for h in s["handovers"] if h["machine_id"] == mid]
    count = lambda t: sum(1 for e in events if e["type"] == t)  # noqa: E731
    done = [t for t in sch["tasks"] if t["status"] == "done"]
    eng = max(u["engine_s"], 1)
    idle_pct = round(100 * u["idle_s"] / eng) if u["engine_s"] else 0
    stops = [e for e in events if e["type"] == "machine_stop"]
    high_sos = [x for x in sos_today if x["risk"] == "high"]
    managed = [x for x in sos_today if x["risk"] == "manageable" and not x.get("escalated")]
    # Rating = 100 minus explainable deductions. SOS and machine faults never cost points:
    # asking for help must always be the right call.
    deductions = [("seatbelt violation", count("seatbelt"), 8), ("fatigue alert", count("fatigue"), 6),
                  ("danger-zone alert", count("proximity"), 3), ("idle alert", count("idle"), 4)]
    breakdown = [{"label": f"{label} ×{n}", "points": -n * pts} for label, n, pts in deductions if n]
    if u["engine_s"] >= 120 and idle_pct > 30:  # efficiency: share of engine time burnt with no work
        breakdown.append({"label": f"{idle_pct}% of engine time idle", "points": -min(20, math.ceil((idle_pct - 30) / 3))})
    rating = max(0, 100 + sum(b["points"] for b in breakdown))

    findings = []
    if u["engine_s"]:
        findings.append(("warn" if idle_pct > 30 else "ok",
                         f"Engine ran {_hm(u['engine_s'])}: {_hm(u['work_s'])} working, {_hm(u['idle_s'])} idle ({idle_pct}% idle)."))
    if u["idle_fuel_l"] > 0:
        findings.append(("warn" if count("idle") else "ok",
                         f"Idling burned {u['idle_fuel_l']:.2f} L diesel (~₹{u['idle_fuel_l'] * DIESEL_INR:.0f}, "
                         f"{u['idle_fuel_l'] * CO2_PER_L:.1f} kg CO₂) with no work done."))
    if count("idle"):
        findings.append(("bad", f"{count('idle')} idle / no-work alert(s) were sent to the supervisor."))
    findings.append(("ok" if len(done) == len(sch["tasks"]) else "info",
                     f"{len(done)} of {len(sch['tasks'])} tasks completed."))
    if done:
        diffs = [(t["actual_min"] - t["prediction"]["predicted_min"]) / t["prediction"]["predicted_min"] * 100 for t in done if t.get("actual_min")]
        if diffs:
            avg = sum(diffs) / len(diffs)
            findings.append(("ok" if avg <= 5 else "warn", f"Tasks took {abs(avg):.0f}% {'longer' if avg > 0 else 'less'} than the AI predicted on average."))
    for st in stops:
        findings.append(("bad", f"{st['time'][11:16]} {st['detail']}."))
    if high_sos:
        findings.append(("bad", f"{len(high_sos)} high-risk SOS: supervisor alerted on WhatsApp + SMS."))
    if managed:
        findings.append(("ok", f"{len(managed)} manageable issue(s) resolved by the operator without escalation."))
    if count("seatbelt"):
        findings.append(("bad", f"{count('seatbelt')} seatbelt violation(s)."))
    if count("proximity"):
        findings.append(("warn", f"{count('proximity')} person-in-danger-zone alert(s)."))
    if count("fatigue"):
        findings.append(("warn", f"{count('fatigue')} fatigue / microsleep alert(s)."))
    if hr["anomalies"]:
        findings.append(("bad", "Machine: " + "; ".join(a["title"] for a in hr["anomalies"]) + "."))
    if not [f for f in findings if f[0] in ("bad", "warn")]:
        findings.append(("ok", "No safety or efficiency problems this shift."))

    return {
        "date": day, "operator": {k: prof[k] for k in ("id", "name", "skill")}, "machine": m,
        "shift": sch["shift"], "generated": now_iso(), "rating": rating, "rating_breakdown": breakdown,
        "utilisation": u | {"idle_pct": idle_pct, "fuel_cost_inr": round(u["fuel_l"] * DIESEL_INR),
                            "idle_cost_inr": round(u["idle_fuel_l"] * DIESEL_INR),
                            "idle_co2_kg": round(u["idle_fuel_l"] * CO2_PER_L, 2)},
        "tasks": [{"task_id": t["task_id"], "task_type": t["task_type"], "status": t["status"], "start": t["start"],
                   "predicted_min": t["prediction"]["predicted_min"], "actual_min": t["actual_min"],
                   "done_by": t.get("done_by_name")} for t in sch["tasks"]],
        "counts": {t: count(t) for t in ("seatbelt", "proximity", "fatigue", "health", "idle", "sos", "machine_stop", "man_down")},
        "findings": [{"level": lv, "text": tx} for lv, tx in findings],
        "timeline": sorted(events, key=lambda e: e["time"]),
        "sos": sos_today, "incidents": incidents, "notifications": notes, "recordings": recs, "handovers": handovers,
        "machine_health": {k: hr[k] for k in ("overall", "alerts", "anomalies")},
    }


@app.post("/api/shift-report/{op_id}/send")
def send_shift_report(op_id: str, machine_id: str | None = None):
    """Send the shift summary to the supervisor on WhatsApp (and SMS)."""
    r = shift_report(op_id, machine_id)
    u = r["utilisation"]
    bad = [f["text"] for f in r["findings"] if f["level"] in ("bad", "warn")][:4]
    alert_supervisor(r["machine"]["machine_id"], op_id, f"Shift report ({r['date']}): rating {r['rating']}/100",
                     f"Engine {_hm(u['engine_s'])}, working {_hm(u['work_s'])}, idle {u['idle_pct']}%", "MEDIUM",
                     None, key=None, kind="report", whatsapp=True,
                     extra=(f"⛽ Fuel {u['fuel_l']:.2f} L (~₹{u['fuel_cost_inr']}), wasted idling {u['idle_fuel_l']:.2f} L. "
                            f"Tasks {sum(1 for t in r['tasks'] if t['status'] == 'done')}/{len(r['tasks'])}. "
                            + (" Issues: " + " | ".join(bad) if bad else " No issues.")))
    return {"ok": True}


# ------------------------------------------------------------------ ASK COPS assistant
class AskIn(BaseModel):
    operator_id: str
    machine_id: str | None = None
    message: str
    history: list[dict] = []
    lang: str = "en-IN"
    walkaround_done: bool = False


def assistant_context(op_id, mid, walkaround_done):
    prof = operator(op_id)
    mid = mid or prof["machine_id"]
    sch = schedule(op_id, mid)
    hl = health_report(mid)
    _, summary = op_summary(op_id)
    try:
        cmp = perf(op_id)["comparison"]
    except Exception:
        cmp = []
    tr = [{"title": m["title"], "reason": m["reason"]} for m in training(op_id)["modules"] if m["recommended"]]
    return {
        "now": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "operator": {k: prof[k] for k in ("id", "name", "skill", "xp")} | {"safety": prof["safety"]},
        "machine": sch["machine"],
        "walkaround_done": walkaround_done,
        "schedule": {
            "shift": sch["shift"], "handover": sch["handover"],
            "tasks": [{"task_id": t["task_id"], "task_type": t["task_type"], "site": t["site"], "start": t["start"],
                       "end": t["end"], "status": t["status"], "weather": t["weather"], "reason": t["reason"],
                       "predicted_min": t["prediction"]["predicted_min"], "low_min": t["prediction"]["low_min"],
                       "high_min": t["prediction"]["high_min"], "site_estimate_min": t["prediction"]["site_estimate_min"]}
                      for t in sch["tasks"]],
            "forecast": [{k: h[k] for k in ("hour", "condition", "temp_c", "heat_index", "wind_kmh")} for h in sch["forecast"]],
        },
        "health": {k: hl[k] for k in ("overall", "engine_on", "alerts", "anomalies", "start_allowed", "block_reason")}
        | {"channels": [{k: c[k] for k in ("key", "label", "value", "unit", "status", "trend", "time_to_critical_s")}
                        for c in hl["channels"]]},
        "insights": {k: summary.get(k) for k in ("idle_cost_inr", "idle_co2_kg", "avoidable_cost_inr", "unfastened", "excess_idle_events")},
        "performance": cmp,
        "training": tr,
        "recent_events": [e for e in state()["events"] if e["operator_id"] == op_id][-8:],
    }


@app.post("/api/assistant")
def ask(body: AskIn):
    get_op(body.operator_id)
    ctx = assistant_context(body.operator_id, body.machine_id, body.walkaround_done)
    text = assistant.ask_claude(body.message, body.history, ctx, body.lang)
    if text:
        _, actions = assistant.ask_rules(body.message, ctx)  # reuse the rule engine's navigation buttons
        return {"answer": text, "actions": actions, "source": "claude", "model": assistant.MODEL}
    answer, actions = assistant.ask_rules(body.message, ctx)
    return {"answer": answer, "actions": actions, "source": "offline"}


@app.get("/api/assistant/suggestions")
def ask_suggestions():
    return assistant.SUGGESTIONS


@app.post("/api/demo/reset")
def reset_demo():
    """Reset live state + learned task history for a clean, repeatable demo run."""
    with lock:
        save_state(empty_state())
        health.reset()
        _anomalies_seen.clear()
        _idle_alerted.clear()
        with sms.lock:  # also restart the hourly cap so demo rehearsals can't use it up
            sms.outbox.clear()
            sms.last_key.clear()
            for sent in sms.sent_times.values():
                sent.clear()
        base = generate_tasks()
        base.to_csv(TASKS_CSV, index=False)
        predictor.mae_history.clear()
        predictor.fit(base)
    return {"ok": True}
