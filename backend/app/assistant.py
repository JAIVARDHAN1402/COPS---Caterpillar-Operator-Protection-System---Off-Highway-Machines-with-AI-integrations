"""ASK COPS: the operator's AI assistant.

Answers questions about the operator's own shift (schedule, safety score, machine
health, weather, training...) and about how to use COPS. Two engines:

* Claude (when Anthropic credentials are available): grounded in a JSON snapshot
  of the operator's live context, with the app's knowledge base in the system prompt.
* Offline rule engine (always available): intent matching over the same context,
  so the assistant still works on a site with no internet.
"""
import json
import os
import re
import time

MODEL = os.environ.get("COPS_LLM_MODEL", "claude-opus-5")
MODE = os.environ.get("COPS_ASSISTANT_MODE", "auto")  # auto | rules | claude
_llm_disabled_until = 0.0
_client = None

KNOWLEDGE = """You are ASK COPS, the AI assistant inside COPS (Caterpillar Operator Protection System),
an operator-assistant app for Caterpillar excavators and loaders. You talk to machine operators and
supervisors on construction sites. Be short, practical and safety-first: 2-6 sentences or a few
bullets, plain language, no markdown headings. If a question is about the operator's own data, answer
ONLY from the JSON context provided in the message; if the data isn't there, say so. Never invent
readings, scores or times. For anything dangerous (low oil pressure, overheating, rollover, a person
in the swing zone, drowsiness) tell them to stop safely first. If the user writes in Hindi (or asks
for Hindi), answer in simple Hindi.

How COPS works (use this to explain features):
- Punch in with Operator ID on the keypad. Tabs: Today, Digital Twin, Machine Health, Safety,
  Performance, Machine Insights, Training Hub, Time Predictor.
- Today: weather-aware schedule (tries all 120 task orders, moves trenching/grading out of rain,
  demolition out of wind), ML-predicted task time with an 80% range and a "Why?" breakdown,
  mandatory 6-item pre-shift walkaround before tasks unlock.
- Engine interlock: the engine (key E or the Engine button) cannot start unless the seatbelt is
  fastened (key B simulates the belt sensor). It also won't start if engine oil or coolant is
  critically low. Removing the belt while the engine runs sounds a siren at once, a final warning
  at 8 s and notifies the supervisor at 16 s.
- Machine Health: live engine oil, oil pressure, coolant, engine temp, hydraulic oil level and temp,
  fuel, DEF/AdBlue, battery, air filter. Warn/critical thresholds, time-to-critical prediction,
  leak detection (level falling far faster than normal consumption). "Service / refill" fixes it.
- Safety tab: AI proximity camera (person < 3 m = STOP, < 6 m = warning), fatigue monitor
  (eyes closed 1.5 s drowsy, 3 s microsleep alarm; 3 yawns in 3 min = break advised), voice incident
  report ("report incident: ..."), near-miss logging, man-down & rollover detection (tilt > 30°
  asks "Are you OK?", no answer in 15 s sends SOS with location), SOS button and voice "help",
  Active mode (periodic "are you OK?" check-ins for operators working alone; a missed check-in
  escalates to "Are you OK?" and then an automatic SOS).
- Black-box replay: every incident, near-miss, microsleep, SOS or rollover saves the last 60 s
  of machine state; replay it in the Digital Twin with a timeline slider.
- Shift handover: "Handover" button records reason, % done and a note; the next operator gets a
  spoken briefing and must acknowledge it.
- Training Hub: lessons picked from the operator's own data, quizzes, XP levels
  (Beginner/Intermediate/Expert), Swing-Zone reflex simulator, instructor booking.
- Performance: 14-day trend, week-over-week, coach tips. Machine Insights: idle fuel cost in rupees
  and CO2, anomaly detection. Time Predictor: what-if planner.
- Supervisor Console (button on the punch-in screen): live SOS alerts, all machines' health,
  safety events, black-box replays.
"""


def _get_client():
    global _client
    if _client is None:
        import anthropic  # optional dependency: rules engine works without it
        _client = anthropic.Anthropic(timeout=25.0, max_retries=1)
    return _client


def _has_credentials():
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def warm_up():
    """Import the SDK in the background at startup (the import alone takes seconds on a cold disk),
    so the operator's first question isn't slow. Skipped when there are no credentials."""
    if MODE != "rules" and _has_credentials():
        import threading
        threading.Thread(target=_get_client, daemon=True).start()


def ask_claude(message, history, context, lang):
    """Returns answer text, or None if Claude is unavailable (caller falls back to rules)."""
    global _llm_disabled_until
    # No key -> answer offline instantly instead of paying a multi-second SDK import to find out.
    if MODE == "rules" or not _has_credentials() or time.time() < _llm_disabled_until:
        return None
    try:
        import anthropic
        client = _get_client()
        msgs = [{"role": m["role"], "content": m["content"]} for m in history[-8:]
                if m.get("role") in ("user", "assistant") and m.get("content")]
        user = (f"Operator context (live JSON, {context.get('now')}):\n{json.dumps(context, default=str)}\n\n"
                f"UI language: {lang}\n\nQuestion: {message}")
        msgs.append({"role": "user", "content": user})
        response = client.beta.messages.create(
            model=MODEL,
            max_tokens=2048,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "low"},  # short conversational answers
            system=[{"type": "text", "text": KNOWLEDGE, "cache_control": {"type": "ephemeral"}}],
            messages=msgs,
        )
        if response.stop_reason == "refusal":
            return None
        text = "".join(b.text for b in response.content if b.type == "text").strip()
        return text or None
    except ImportError:
        _llm_disabled_until = time.time() + 3600
        return None
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError, anthropic.NotFoundError, anthropic.BadRequestError):
        _llm_disabled_until = time.time() + 600  # no usable credentials/model: stay offline for a while
        return None
    except (anthropic.RateLimitError, anthropic.APIConnectionError, anthropic.APIStatusError):
        _llm_disabled_until = time.time() + 60   # transient: retry Claude in a minute
        return None
    except Exception:
        # Missing credentials raise at client construction; stay on the offline engine.
        _llm_disabled_until = time.time() + 600
        return None


# ------------------------------------------------------------------ offline rule engine
def _fmt_min(m):
    m = int(round(m))
    return f"{m // 60}h {m % 60:02d}m" if m >= 60 else f"{m} min"


def _has(t, *words):
    return any(re.search(w, t) for w in words)


WEATHER_WORDS = r"weather|rain|wind|heat\b|baarish|बारिश|mausam|मौसम"


def _named_channels(t):
    """Which health channels a question is about (empty = give an overview)."""
    keys = []
    hyd = "hydraulic" in t
    hot = _has(t, r"temp|hot|overheat|garam")
    if "pressure" in t:
        keys.append("oil_pressure")
    if hyd:
        keys.append("hydraulic_temp" if hot else "hydraulic_oil")
    if _has(t, r"engine oil|oil level|\boil\b|तेल") and not hyd and "pressure" not in t:
        keys.append("engine_oil")
    if _has(t, r"coolant|radiator"):
        keys.append("coolant")
    if hot and not hyd:
        keys.append("engine_temp")
    if _has(t, r"fuel|diesel|डीजल"):
        keys.append("fuel")
    if _has(t, r"\bdef\b|adblue"):
        keys.append("def")
    if "battery" in t:
        keys.append("battery")
    if _has(t, r"filter"):
        keys.append("air_filter")
    return keys


def ask_rules(message, ctx):
    t = message.lower().strip()
    p, sch, hl = ctx.get("operator", {}), ctx.get("schedule", {}), ctx.get("health", {})
    tasks = sch.get("tasks", [])
    pending = [x for x in tasks if x["status"] in ("pending", "paused")]
    nxt = pending[0] if pending else None
    actions, answer = [], None

    if _has(t, r"^(hi|hello|hey|namaste|नमस्ते)\b", r"what can you do", r"help me\b", r"^help$", r"कैसे मदद"):
        answer = (f"Hi {p.get('name', '').split(' ')[0]}! I'm ASK COPS. Ask me about your next task, task times, "
                  "your safety score, machine health (oil, coolant, hydraulics, fuel), weather, fatigue, training, "
                  "how to report an incident, hand over a shift, or send an SOS.")
    elif _has(t, r"sos|emergency|rollover|roll over|tip over|man.?down|मदद|बचाओ"):
        answer = ("For an emergency press the red 🆘 SOS button (top bar) or just say \"Help!\". COPS sends your "
                  "location to the supervisor. If the machine tilts more than 30° it asks \"Are you OK?\" and sends an "
                  "SOS automatically if you don't answer within 15 seconds. In a rollover: stay in the cab, belted, and hold on.")
        actions.append({"label": "Open Safety → Emergency", "tab": "safety"})
    elif _has(t, r"oil|coolant|hydraulic|fuel|diesel|def|adblue|battery|filter|temp|overheat|fluid|level|health|leak|engine status|machine status|तेल|डीजल"):
        chans = hl.get("channels", [])
        wanted = _named_channels(t)
        named = [c for c in chans if c["key"] in wanted]
        pick = named or [c for c in chans if c["status"] in ("warn", "crit")] or chans[:4]
        lines = []
        for c in pick[:5]:
            s = {"ok": "OK", "warn": "WARNING", "crit": "CRITICAL", "off": "engine off"}[c["status"]]
            ttc = c.get("time_to_critical_s")
            eta = "" if ttc is None else (", under 1 min to critical!" if ttc < 60
                                          else f", about {_fmt_min(ttc / 60)} to critical at this rate")
            lines.append(f"• {c['label']}: {c['value']}{c['unit']} ({s}{eta})")
        answer = f"Machine health is {hl.get('overall', 'ok').upper()}.\n" + "\n".join(lines)
        for a in hl.get("anomalies", [])[:2]:
            if not wanted or a["key"] in wanted:
                answer += f"\n⚠️ {a['title']}. {a['detail']}"
        crit = [a for a in hl.get("alerts", []) if a["status"] == "crit"]
        if crit:
            answer += f"\nDo this now: {crit[0]['action']}"
        actions.append({"label": "Open Machine Health", "tab": "health"})
    elif _has(t, r"engine.*(start|won'?t|not)|can'?t start|seat ?belt|interlock"):
        reason = hl.get("block_reason")
        answer = ("The engine only starts with the seatbelt fastened (press B to simulate the belt sensor, then E or the "
                  "Engine button). Removing the belt while it runs sounds a siren and alerts your supervisor at 16 s.")
        if reason:
            answer += f" Right now the start is also blocked because: {reason}. Service the machine first."
    elif _has(t, r"next|what should i do|what now|agla|अगला|kya karna"):
        if nxt:
            answer = (f"Next: {nxt['task_type']} at {nxt['site']}, starting {nxt['start']}, about "
                      f"{_fmt_min(nxt['predicted_min'])} (weather {nxt['weather']}).")
            if nxt.get("reason"):
                answer += f" Scheduled there because: {nxt['reason']}."
            if not ctx.get("walkaround_done"):
                answer += " Finish the pre-shift walkaround first, since tasks are locked until it's done."
        else:
            answer = "All of today's tasks are done. Great work!"
        actions.append({"label": "Open Today", "tab": "today"})
    elif _has(t, r"how long|time.*(take|need)|kitna time|कितना समय|predict"):
        hit = next((x for x in tasks if x["task_type"].lower().split()[0] in t or x["task_type"].lower() in t), None)
        if hit:
            answer = (f"{hit['task_type']} is predicted at {hit['predicted_min']} min "
                      f"(80% range {hit['low_min']}–{hit['high_min']}) for your skill, machine and {hit['weather'].lower()} weather. "
                      f"The site's static estimate is {hit['site_estimate_min']} min.")
        else:
            total = sum(x["predicted_min"] for x in pending)
            answer = f"Your remaining {len(pending)} tasks add up to about {_fmt_min(total)} of work."
        actions.append({"label": "Open Time Predictor", "tab": "predictor"})
    elif _has(t, r"schedule|plan|today|tasks|aaj|आज") and not _has(t, WEATHER_WORDS):
        rows = [f"• {x['start']} {x['task_type']} ({x['status'].replace('_', ' ')}, ~{int(x['predicted_min'])} min, {x['weather']})"
                for x in tasks]
        answer = "Today's plan:\n" + "\n".join(rows)
        actions.append({"label": "Open Today", "tab": "today"})
    elif _has(t, r"score|grade|safety point|kitna score"):
        sc = p.get("safety", {})
        neg = sorted([b for b in sc.get("breakdown", []) if b["points"] < 0], key=lambda b: b["points"])
        answer = f"Your safety score is {sc.get('score')}/100 (grade {sc.get('grade')})."
        if neg:
            answer += " Biggest deductions: " + ", ".join(f"{b['label']} ({b['points']})" for b in neg[:2]) + "."
        answer += " Completing recommended lessons adds points, and reporting incidents never lowers it."
        actions.append({"label": "Open Training Hub", "tab": "training"})
    elif _has(t, WEATHER_WORDS):
        fc = sch.get("forecast", [])
        rain = [h["hour"] for h in fc if h["condition"] == "Rainy"]
        wind = [h["hour"] for h in fc if h["condition"] == "Windy"]
        hot = max((h["heat_index"] for h in fc), default=0)
        parts = []
        if rain:
            parts.append(f"rain {rain[0]}:00–{rain[-1] + 1}:00 (keep 1 m from trench edges)")
        if wind:
            parts.append(f"wind at {', '.join(str(h) + ':00' for h in wind)} (pause high-reach demolition)")
        if hot >= 38:
            parts.append(f"heat index up to {hot}°C (drink water every 30 min)")
        answer = "Today: " + ("; ".join(parts) if parts else "clear conditions") + ". Your schedule is already arranged around it."
    elif _has(t, r"tired|sleepy|fatigue|drowsy|break|neend|नींद|थक"):
        answer = ("If you feel drowsy, park safely, lower the bucket and take a 10-minute break. The fatigue monitor "
                  "(Safety tab) alarms at 3 s of closed eyes and blocks new tasks while you're drowsy.")
        actions.append({"label": "Open Safety", "tab": "safety"})
    elif _has(t, r"idle|fuel cost|waste|rupee|₹|co2|carbon"):
        ins = ctx.get("insights", {})
        answer = (f"In the last 14 days idling burned about ₹{ins.get('idle_cost_inr', 0):,} of diesel "
                  f"({ins.get('idle_co2_kg', 0)} kg CO₂); about ₹{ins.get('avoidable_cost_inr', 0):,} was avoidable. "
                  "Shut down if you'll wait more than 5 minutes.")
        actions.append({"label": "Open Machine Insights", "tab": "insights"})
    elif _has(t, r"train|learn|lesson|course|sikh|सीख"):
        recs = ctx.get("training", [])
        answer = ("Recommended for you: " + "; ".join(f"{r['title']} ({r['reason']})" for r in recs[:3]) + ".") if recs \
            else "No specific lessons are pending. Try the Swing-Zone Reflex simulator in the Training Hub."
        actions.append({"label": "Open Training Hub", "tab": "training"})
    elif _has(t, r"improv|progress|perform|week"):
        cmp = ctx.get("performance", [])
        if cmp:
            answer = "Week over week: " + "; ".join(
                f"{c['label']} {c['prev']} → {c['curr']}{'' if c['unit'] in ('', 'min') else c['unit']}" for c in cmp[:4]) + "."
        else:
            answer = "Open the Performance tab to see your 14-day trend."
        actions.append({"label": "Open Performance", "tab": "performance"})
    elif _has(t, r"incident|accident|near.?miss|report|ghatna|घटना"):
        answer = ("Say \"Report incident:\" followed by what happened (for example \"a rock hit the windshield near "
                  "trench 3\"), or type it in Safety → Incident report. COPS fills in type, severity and location, "
                  "attaches the machine's black box, and saves a 60-second 3D replay.")
        actions.append({"label": "Open Safety", "tab": "safety"})
    elif _has(t, r"hand ?over|leave|shift end|punch out"):
        answer = ("Press ⇄ Handover, pick the reason, set how far you got, and add a note. The next operator who punches "
                  "in gets a spoken briefing and must acknowledge it before working.")
    elif _has(t, r"replay|black ?box|twin|3d"):
        answer = ("The Digital Twin shows your machine live in 3D. Every incident, near-miss, microsleep, SOS or rollover "
                  "saves the last 60 seconds; open Digital Twin → Black-box recordings and drag the timeline to replay it.")
        actions.append({"label": "Open Digital Twin", "tab": "twin"})
    elif _has(t, r"camera|proximity|person|worker|swing"):
        answer = ("The rear camera AI detects people: under 3 m it shouts STOP and inhibits movement, under 6 m it warns. "
                  "Keep 3 m plus the swing radius clear.")
        actions.append({"label": "Open Safety", "tab": "safety"})
    elif _has(t, r"who am i|my (profile|level|skill|xp)|level"):
        answer = (f"You are {p.get('name')} ({p.get('id')}), {p.get('skill')} level with {p.get('xp')} XP, "
                  f"on the {ctx.get('machine', {}).get('machine')}.")
    elif _has(t, r"thank|thanks|shukriya|dhanyavad|धन्यवाद"):
        answer = "You're welcome. Stay safe out there!"

    if answer is None:
        answer = ("I'm not sure about that one. I can help with: next task, task times, today's plan, safety score, "
                  "machine health (oil, coolant, hydraulics, fuel), weather, fatigue, idle cost, training, incidents, "
                  "handover, SOS and replays.")
    return answer, actions


SUGGESTIONS = ["What's my next task?", "Is my machine healthy?", "Why is my safety score low?",
               "How do I send an SOS?", "What's the weather today?", "How long will trenching take?"]
