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

Use **↺ Reset demo** in the footer before presenting.

## Tech
React + Vite · TensorFlow.js (COCO-SSD) · Web Speech API · Recharts ·
FastAPI · scikit-learn (GradientBoosting, IsolationForest) · pandas

## Roadmap ideas (for the pitch)
- Real CAN-bus / CAT Product Link telemetry feed instead of CSV
- Fatigue detection (MediaPipe eye-blink) in the cab camera
- LLM-based incident parsing for free-form multilingual reports
- Offline-first PWA with background sync for sites without network
- Supervisor fleet dashboard
