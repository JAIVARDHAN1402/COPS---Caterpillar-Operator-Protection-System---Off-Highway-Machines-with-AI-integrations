# COPS: Caterpillar Operator Protection System

An AI companion for Caterpillar machine operators. Instead of five separate
features, it runs one closed loop:

```
Telemetry ─► anomaly detected ─► safety score drops ─► personalised micro-lesson
    ▲                                                        │
    └── task-time model retrains ◄── skill level rises ◄─────┘
```

## Run it

**One click (Windows):** double-click `start.bat`, then open http://localhost:5173

**Manual:**
```bash
# API (Python 3.11)
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m uvicorn app.main:app --port 8000

# Web (Node 18+), second terminal
cd frontend
npm install
npm run dev
```
Use **Chrome or Edge**, because voice recognition needs the Web Speech API.

## How each requirement is met

| Requirement | What we built | What makes it different |
|---|---|---|
| **Daily task dashboard** | Smart schedule, forecast strip, pre-shift walkaround | **Weather-aware scheduler** tries all 120 task orders and moves trenching/grading out of rain and demolition out of wind. Every move is explained. Tasks stay locked until the walkaround is done. |
| **Seatbelt compliance** | Sensor simulation (key **B**), engine key (key **E**) | **Engine interlock:** the engine (and any task) cannot start without the belt; a blocked attempt triggers a siren, a red banner and a log entry. **Belt removed while the engine runs:** the siren starts immediately and repeats every 2 s, with a final warning at 8 s and the supervisor notified and logged at 16 s. Voice alerts in English and Hindi. |
| **Proximity hazards** | Live webcam person detection (COCO-SSD, runs in the browser) | Distance estimated from body size, **red/amber zones**, top-down **swing radar**, voice "STOP" and a one-tap **log as near-miss**. A simulation button works without a camera. |
| **Incident logging** | Speak or type a sentence | **Speech → structured report**: type, severity, location, persons involved, immediate action. A **telemetry black-box** is attached. Reporting *raises* the safety score. |
| **Working conditions** | Heat index, rain, wind advice | Hydration breaks, trench-edge rules, wind pauses, and weather-clearing waits built into the schedule |
| **Training hub** | Micro-lessons, quiz, XP and levels, instructor booking, **Swing-Zone Reflex simulator** | Lessons are picked from **the operator's own telemetry** and today's forecast. Levelling up changes the operator's predicted task times. |
| **Unusual behaviour** | IsolationForest + explainable rules | Each flag says *why* ("60 min idle, 1 load cycle, 17× fleet ratio"). Idling is shown in **₹ and kg CO₂**. It also found the pattern in the provided data: **seatbelt off ⇔ high idle**, meaning the operator leaves the cab with the engine running. |
| **Task time estimation** | Gradient boosting with 10/50/90 quantiles | **~4–5× more accurate** than the site's static estimates, with an uncertainty range, a **waterfall explanation** per factor, what-if sliders, and **online learning** when a task is completed. |

### Phase 2 features

| Feature | What it does |
|---|---|
| **Heritage theme** | Caterpillar machines were battleship gray until 1931, then Hi-Way Yellow. The UI is steel gray that "grows into" yellow: the header stripe, the logo animation on load, progress bars, and **operator skill** (Beginner = gray → Expert = CAT yellow). |
| **Fatigue detection** | Cab camera + MediaPipe Face Landmarker (runs offline in the browser). Eyes closed ≥1.5 s → drowsy warning; ≥3 s → **microsleep alarm**, logged, tasks blocked. 3+ yawns in 3 min or PERCLOS > 20% → a break is advised with a 10-min break timer. Buttons to simulate microsleep and yawning for the demo. |
| **Performance feedback loop** | New *Performance* tab. The loop runs Measured → Detected → Coached → Trained → Improved. It shows a 14-day trend plus a live point for today, week-over-week deltas, coach feedback with "fix it" links to lessons, goals, you-vs-AI times, and the model's own error curve. |
| **Shift handover** | Operators **punch in** with their ID. *⇄ Handover* records the reason, % done on the current task and a note (dictation works). When the next operator punches in, they get a **spoken briefing**: what's done and by whom, the half-done task and time left, remaining work re-predicted for *their* skill, a shift-overrun warning, hazards left on site, weather ahead, and the note. They must acknowledge it before taking over. |
| **AI confidence report** | Every AI output shows an **"AI 84%" badge** in the corner. Clicking it shows the method, what the number is based on (sample sizes, error, detector certainty) and its limitations. Confidence is capped at 95%: the AI never claims certainty. |

### 🚜 Digital Twin + Fusion 360
The **Digital Twin** tab is a 3D excavator (three.js) driven by live app state:
- It digs while a task runs, and **freezes on any interlock** (seatbelt, person in zone, drowsiness), with a red beacon.
- The swing danger/warning rings show the **worker the proximity camera sees**, at the right distance and bearing.
- **Walkaround hotspots** can be clicked in 3D and stay in sync with the Today checklist.
- The **engine glows while idling**, with a live fuel-cost counter, and the cab flashes on microsleep.
- **Paint shifts from gray to CAT yellow** as the operator's skill grows.

It uses a built-in placeholder until you provide a Fusion 360 model.
`fusion/CATCoPilotExcavator` is a **Fusion 360 script** that builds a twin-ready excavator (nested components,
origins on the pivot pins, names the app recognizes). Export it as FBX to `frontend/public/models/excavator.fbx`,
or drag it onto the 3D view. Full guide: [fusion/README.md](fusion/README.md).

### Phase 3: response, monitoring & assistant

| Feature | What it does |
|---|---|
| **🛢️ Machine Health (runtime monitoring)** | A live sensor stream (every 2 s) of engine oil level and pressure, coolant, engine temp, hydraulic oil level and temp, fuel, DEF/AdBlue, battery and air-filter restriction. Each channel has warn/critical thresholds, a trend, a 5-minute sparkline and a **time-to-critical prediction**. **Leak detection** flags fluid falling far faster than normal consumption (e.g. "hydraulic oil falling 18%/min, 375× normal"). Critical alerts sound a siren and speak the recommended action. **Engine start is blocked** if oil or coolant is critically low. Demo buttons inject leaks, overheating, a clogged filter or low fuel; "Service / refill" fixes them. |
| **🎬 Black-box incident replay** | The machine state (swing, seatbelt, worker distance, alertness, tilt, health) is sampled 4×/s into a rolling 60-s buffer. Every incident, near-miss, microsleep, seatbelt escalation, SOS, rollover or critical fault saves it automatically. **Replay it in the 3D Digital Twin** with a timeline slider, play/pause, 1–4× speed and "jump to event". |
| **🆘 Man-down, rollover & SOS** | The tablet/phone tilt sensor detects a rollover (> 30° for 1 s) or a heavy impact (> 3 g), then asks **"Are you OK?"** with a 15-s countdown and a spoken prompt (answer by tapping or saying "I'm OK" / "Help"). No answer means an **automatic SOS with GPS location**. The **SOS button** asks what's happening (high-risk or manageable, see below), a voice **"Help!"** raises a high-risk SOS, and **Active mode** adds periodic "tap to confirm you're OK" check-ins for operators working alone. A missed check-in escalates to "Are you OK?" and then an automatic SOS. The 3D twin tilts with the machine. |
| **🧑‍💼 Supervisor Console** | Opened from the punch-in screen (or `/#supervisor`): live SOS alerts with a siren, location and Maps link, Acknowledge/Resolve (the operator sees the acknowledgement), every machine's live health, the fleet safety-event feed, pending handovers, incidents and black-box replays. |
| **💬 ASK COPS AI assistant** | A floating chat on every page with voice input and spoken answers. It answers questions about the operator's own shift (next task, task times, safety score, machine health, weather, fatigue, idle cost, training) and about how to use COPS, with buttons that jump to the right tab. Voice questions the command engine doesn't recognise go to ASK COPS automatically. It uses **Claude** (`claude-opus-5`, low effort, server-side refusal fallbacks) when Anthropic credentials are available (e.g. `ANTHROPIC_API_KEY`), and otherwise an **offline rule engine** grounded in the same live data, so it always works on site. Set `COPS_ASSISTANT_MODE=rules` to force offline, or `COPS_LLM_MODEL` to change the model. |

### 📨 WhatsApp + SMS alerts, smart SOS, idle watchdog & Shift Report
- **Two levels of SOS.** The SOS button asks *"What's happening?"*
  - **🚨 High risk** (injury, rollover, fire, person hit or trapped, utility strike, other serious danger): the supervisor gets a **WhatsApp + SMS at once** with a Google Maps link, and the engine is emergency-stopped.
  - **🛠️ Manageable** (breakdown, stuck in mud, warning light, fluid top-up, blocked path): the operator gets **spoken, step-by-step guidance** and the machine keeps running. Nobody is disturbed unless it isn't solved: after **60 s** (or on *Escalate now*) it becomes a high-risk SOS and the supervisor is alerted on WhatsApp.
- **Idle watchdog (fuel waste).** Engine running with **no task for 60 s** sends the supervisor a WhatsApp + SMS with the litres of diesel, rupees and kg of CO₂ wasted so far; a second alert follows at 3 min. Fuel is metered at each machine's real burn rate (e.g. CAT 320: 15 L/h working, 3.5 L/h idling). The cab shows an idle banner.
- **Emergency stop:** a critical incident while the engine runs (critical oil, oil pressure, coolant, engine temp or hydraulic oil; high-risk SOS or rollover; microsleep) **shuts the engine down automatically**, shows a red *EMERGENCY STOP* banner and alerts the supervisor.
- **Which channel:** WhatsApp **and** SMS for high-risk SOS, emergency stops, idling with no work, microsleep and critical machine faults. SMS for the other discrepancies (seatbelt, danger zone, fluid warnings, incidents, handovers).
- **Each message states** what happened, the reason, operator, time, recommended action and **"Before this"**, the preceding events. Duplicates are suppressed for 2 minutes, with a cap of 30 per hour per channel.
- **📄 Shift Report tab:** engine / working / idle time, fuel used and wasted (₹, CO₂), smart findings, tasks, SOS and incidents, every WhatsApp and SMS sent, and the full shift log. The shift rating shows each deduction (seatbelt, fatigue, danger zone, idle); **SOS and machine faults never lower it**, so asking for help is always the right call. *Send to supervisor* shares it on WhatsApp; *Print / PDF* saves it.
- **Setup:** copy `backend/.env.example` to `backend/.env` and set `COPS_SMS_TO` (the supervisor's number). For **WhatsApp**, the supervisor activates the free CallMeBot API (send *"I allow callmebot to send me messages"* to CallMeBot's WhatsApp number, see callmebot.com) and puts the key it replies with in `CALLMEBOT_API_KEY`; or use Twilio (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`). For **SMS**: `FAST2SMS_API_KEY` (India) or Twilio (`TWILIO_FROM`). Restart the API and use **Test WhatsApp / Test SMS** in the Supervisor Console. Without keys, messages are **simulated**: fully generated and shown in the outbox and Shift Report, but not sent. `COPS_IDLE_ALERT_S` changes the idle threshold. `backend/.env` is git-ignored, so phone numbers and keys are never committed.

### About the data
The brief supplies 4 telemetry rows and 5 task rows, too few to train on.
`backend/app/data_gen.py` generates ~900 tasks and ~170 telemetry windows.
Their effects are **calibrated so the original rows fit the same pattern**, and
the original rows are kept in the datasets. We tell the judges this openly.

## 3-minute demo script ("A day with Raju")
1. **Today tab:** "Rain at 10, wind at 14. COPS re-planned Raju's day and explains every move." Click **Why?** on a task to show the waterfall.
2. Try **Start**. It's 🔒 until the walkaround is done. Tick the checklist, then start.
3. **Seatbelt:** press **B** (belt off), then **E** (start engine). The start is **blocked** with a siren and a red banner. Press **B** to fasten, then **E**, and the engine starts. Now press **B** again mid-work: the **siren sounds immediately** and repeats, and the supervisor is notified at 16 s. Press **B** to fasten.
4. **Safety tab → Start camera.** A teammate walks into view and the red zone, voice STOP and radar respond. Tap **Log as near-miss**.
5. 🎙️ Say: *"Report incident: a rock hit the windshield near trench 3, nobody was hurt."* The form fills itself.
6. **Machine Insights:** "₹11,000 of diesel burned idling, and notice that the seatbelt-off windows *are* the idle windows."
7. **Training Hub:** the seatbelt lesson is recommended *because of that data*. Pass the quiz for +XP and a higher score. Play the reflex simulator.
8. **Today → Complete** a task. "The model just retrained. It gets smarter every shift."
9. **Safety → Simulate microsleep** (or close your eyes in front of the camera). Drowsy → MICROSLEEP alarm, and task start is blocked.
10. **Performance tab:** "Raju's seatbelt compliance went from 57% to 82% in a week. That's the loop working."
11. **⇄ Handover → Medical emergency**, 40% done, add a note. Then punch in as **OP1002 (Priya)**. The briefing is read aloud with remaining work predicted at *her* pace.
12. Click any **AI %** badge: "Every AI output tells you how sure it is, and why."
13. **🆘 SOS → Stuck in mud** (manageable): guided steps are spoken and the machine keeps running. Tap **Escalate now**: the supervisor gets a WhatsApp and the engine stops. Show it in the **Supervisor Console**.
14. Start the engine (**E**) and do nothing for a minute: the idle banner appears and the supervisor is alerted on WhatsApp with the diesel wasted.
15. **📄 Shift Report:** "Everything that happened this shift, what it cost, and every message the supervisor received, in one page."

Use **↺ Reset demo** in the footer before presenting.

## Tech
React + Vite · three.js (Fusion 360 FBX digital twin) · TensorFlow.js (COCO-SSD) · MediaPipe Face Landmarker ·
Web Speech API · Recharts · FastAPI · scikit-learn (GradientBoosting, IsolationForest) · pandas ·
Claude API (ASK COPS) · WhatsApp (CallMeBot / Twilio) and SMS (Fast2SMS / Twilio) alerts

## Roadmap ideas (for the pitch)
- Real CAN-bus / CAT Product Link telemetry feed instead of CSV
- LLM-based incident parsing for free-form multilingual reports
- Offline-first PWA with background sync for sites without network
- Fleet-wide fuel and utilisation benchmarking across sites
