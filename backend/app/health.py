"""Runtime machine-health monitoring: fluid levels, temperatures, electrical.

Each machine has a live sensor model advanced in (accelerated) real time.
Readings drift realistically with engine state and work; demo faults (leaks,
overheating, clogged filter...) can be injected. For every channel we compute
status against warn/critical thresholds, the rate of change, a time-to-critical
prediction (linear trend over the last minute), and anomaly flags such as
"level falling far faster than normal consumption = likely leak".
"""
import math
import random
import time
from collections import deque

from .ml import confidence

AMBIENT_C = 34.0
SAMPLE_EVERY_S = 2.0
HISTORY = 150  # 150 x 2 s = last 5 minutes

# key, label, unit, direction ("low" = low is bad, "high" = high is bad), warn, crit, gauge max, action
CHANNELS = [
    ("engine_oil", "Engine oil level", "%", "low", 60, 40, 100,
     "Stop the engine, check the dipstick, top up oil and inspect for leaks."),
    ("oil_pressure", "Engine oil pressure", "kPa", "low", 200, 140, 600,
     "STOP THE ENGINE IMMEDIATELY: low oil pressure destroys bearings within minutes."),
    ("coolant", "Coolant level", "%", "low", 60, 40, 100,
     "Let the engine cool before opening the radiator cap, then top up coolant."),
    ("engine_temp", "Engine coolant temp", "°C", "high", 100, 108, 130,
     "Reduce load and idle for 3-5 min; shut down if the temperature keeps rising."),
    ("hydraulic_oil", "Hydraulic oil level", "%", "low", 60, 40, 100,
     "Lower attachments to the ground, stop the machine, inspect hoses and cylinders for leaks."),
    ("hydraulic_temp", "Hydraulic oil temp", "°C", "high", 80, 90, 110,
     "Reduce cycle rate, check hydraulic oil level and clean the oil-cooler fins."),
    ("fuel", "Fuel level", "%", "low", 20, 10, 100,
     "Refuel at the next break; below 10% air can enter the fuel system."),
    ("def", "DEF (AdBlue) level", "%", "low", 15, 5, 100,
     "Refill DEF: the engine will derate (lose power) when DEF runs out."),
    ("battery", "Battery voltage", "V", "low", 24.0, 23.0, 30,
     "Check the alternator belt and charging system."),
    ("air_filter", "Air filter restriction", "%", "high", 70, 85, 100,
     "Clean or replace the air filter element to protect the engine."),
]
META = {c[0]: dict(zip(["key", "label", "unit", "dir", "warn", "crit", "max", "action"], c)) for c in CHANNELS}
RUNNING_ONLY = {"oil_pressure"}  # meaningless with the engine off

FAULTS = {
    "hydraulic_leak": "Hydraulic hose leak",
    "oil_leak": "Engine oil leak",
    "overheat": "Cooling failure (overheating)",
    "low_fuel": "Fuel nearly empty",
    "clogged_filter": "Air filter clogging",
    "battery": "Charging system fault",
}

# Real-world diesel burn (litres/hour) used for the fuel accounting in the shift report.
BURN_LPH = {"EXC001": (15.0, 3.5), "EXC002": (24.0, 5.0), "LDR001": (14.0, 3.0)}  # (working, idling)

START = {
    "EXC001": dict(engine_oil=88, coolant=92, hydraulic_oil=84, fuel=64, def_=55, battery=24.8, air_filter=38),
    "EXC002": dict(engine_oil=94, coolant=96, hydraulic_oil=92, fuel=81, def_=72, battery=25.1, air_filter=22),
    "LDR001": dict(engine_oil=79, coolant=88, hydraulic_oil=77, fuel=24, def_=31, battery=24.5, air_filter=64),
}


class MachineHealth:
    def __init__(self, machine_id):
        s = START.get(machine_id, START["EXC001"])
        self.machine_id = machine_id
        self.v = {
            "engine_oil": s["engine_oil"], "oil_pressure": 0.0, "coolant": s["coolant"],
            "engine_temp": AMBIENT_C, "hydraulic_oil": s["hydraulic_oil"], "hydraulic_temp": AMBIENT_C,
            "fuel": s["fuel"], "def": s["def_"], "battery": s["battery"], "air_filter": s["air_filter"],
        }
        self.engine_on = False
        self.working = False
        self.started_at = 0.0
        # utilisation accounting for the shift report
        self.work_lph, self.idle_lph = BURN_LPH.get(machine_id, (15.0, 3.5))
        self.engine_s = self.work_s = self.idle_s = 0.0
        self.fuel_l = self.idle_fuel_l = 0.0
        self.episode_fuel_l = 0.0       # fuel burnt in the current idle episode
        self.idle_since = None          # start of the current idle episode (engine on, no work)
        self.idle_episodes = 0
        self.longest_idle_s = 0.0
        self.faults = set()
        self.last = time.time()
        self.last_sample = 0.0
        self.history = deque(maxlen=HISTORY)
        self.status = {k: "ok" for k in META}
        self.rng = random.Random(machine_id)
        self._sample(force=True)

    # ---------------------------------------------------------------- simulation
    def set_engine(self, on, working):
        self.advance()
        if on and not self.engine_on:
            self.started_at = time.time()
        self.engine_on, self.working = bool(on), bool(on and working)
        idle = self.engine_on and not self.working
        if idle and self.idle_since is None:
            self.idle_since = time.time()
            self.idle_episodes += 1
            self.episode_fuel_l = 0.0
        elif not idle and self.idle_since is not None:
            self.longest_idle_s = max(self.longest_idle_s, time.time() - self.idle_since)
            self.idle_since = None

    def advance(self):
        now = time.time()
        dt = min(now - self.last, 30.0)  # cap long gaps (server idle) so values don't jump
        self.last = now
        steps = max(1, int(dt / 1.0))
        for _ in range(steps):
            self._step(dt / steps)
        self._sample()

    def _approach(self, key, target, tau, dt):
        self.v[key] += (target - self.v[key]) * (1 - math.exp(-dt / tau))

    def _step(self, dt):
        v, on, work, f = self.v, self.engine_on, self.working, self.faults
        if on:  # utilisation + real-rate fuel accounting
            self.engine_s += dt
            if work:
                self.work_s += dt
                self.fuel_l += self.work_lph * dt / 3600
            else:
                self.idle_s += dt
                burn = self.idle_lph * dt / 3600
                self.fuel_l += burn
                self.idle_fuel_l += burn
                self.episode_fuel_l += burn
        if on:
            v["fuel"] -= (0.030 if work else 0.012) * dt   # demo-accelerated consumption
            v["def"] -= (0.004 if work else 0.0015) * dt
            v["engine_oil"] -= 0.0004 * dt
            v["hydraulic_oil"] -= (0.0008 if work else 0.0002) * dt
            v["coolant"] -= 0.0003 * dt
            v["air_filter"] += (0.002 if work else 0.0005) * dt
        if "hydraulic_leak" in f:
            v["hydraulic_oil"] -= (0.30 if on else 0.05) * dt
        if "oil_leak" in f:
            v["engine_oil"] -= (0.25 if on else 0.04) * dt
        if "overheat" in f:
            v["coolant"] -= 0.08 * dt
        if "clogged_filter" in f and on:
            v["air_filter"] += 0.25 * dt
        if "low_fuel" in f:
            v["fuel"] = min(v["fuel"], 12.0)
            f.discard("low_fuel")

        # temperatures
        eng_target = AMBIENT_C
        if on:
            eng_target = 92 if work else 86
            if "overheat" in f:
                eng_target = 116
            if v["coolant"] < 40:
                eng_target += 20
            if v["air_filter"] > 85:
                eng_target += 5
        self._approach("engine_temp", eng_target, 20 if on else 70, dt)
        hyd_target = AMBIENT_C if not on else (62 if work else 48)
        if on and v["hydraulic_oil"] < 40:
            hyd_target += 25
        self._approach("hydraulic_temp", hyd_target, 30 if on else 90, dt)

        # electrical + oil pressure
        bat_target = 27.8 if on else 24.6
        if "battery" in f:
            bat_target = 23.1
        self._approach("battery", bat_target, 15, dt)
        if on:
            p = 390 - max(0.0, 55 - v["engine_oil"]) * 7 - max(0.0, v["engine_temp"] - 100) * 3
            self._approach("oil_pressure", p, 3, dt)
        else:
            self._approach("oil_pressure", 0.0, 2, dt)

        for k in ("engine_oil", "coolant", "hydraulic_oil", "fuel", "def", "air_filter"):
            v[k] = max(0.0, min(100.0, v[k]))

    def _sample(self, force=False):
        now = time.time()
        if force or now - self.last_sample >= SAMPLE_EVERY_S:
            self.last_sample = now
            self.history.append({"t": round(now, 1), **{k: round(x, 2) for k, x in self.v.items()}})

    # ---------------------------------------------------------------- demo controls
    def inject(self, fault):
        if fault not in FAULTS:
            raise KeyError(fault)
        self.advance()
        self.faults.add(fault)

    def service(self, what="all"):
        """Maintenance: refill fluids / fix faults."""
        self.advance()
        v = self.v
        if what in ("all", "fluids"):
            v["engine_oil"], v["coolant"], v["hydraulic_oil"], v["def"] = 95.0, 96.0, 95.0, 98.0
        if what in ("all", "fuel"):
            v["fuel"] = 100.0
        if what in ("all", "filter"):
            v["air_filter"] = 18.0
        self.faults.clear()

    # ---------------------------------------------------------------- analysis
    def _level(self, key, val):
        m = META[key]
        if key in RUNNING_ONLY and not self.engine_on:
            return "off"
        if key == "oil_pressure" and time.time() - self.started_at < 8:
            return "ok"  # pressure is still building right after start-up
        if m["dir"] == "low":
            return "crit" if val < m["crit"] else "warn" if val < m["warn"] else "ok"
        return "crit" if val > m["crit"] else "warn" if val > m["warn"] else "ok"

    def _slope(self, key, n=10):
        """Least-squares rate of change (units per second) over the last ~20 s (fast leak detection)."""
        pts = list(self.history)[-n:]
        if len(pts) < 5:
            return 0.0
        t0 = pts[0]["t"]
        xs = [p["t"] - t0 for p in pts]
        ys = [p[key] for p in pts]
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        den = sum((x - mx) ** 2 for x in xs)
        return 0.0 if den == 0 else sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den

    def report(self):
        self.advance()
        channels, alerts, anomalies = [], [], []
        transitions = []
        for key, m in META.items():
            val = self.v[key]
            st = self._level(key, val)
            slope = self._slope(key)
            ttc = None
            if st != "crit" and st != "off":
                if m["dir"] == "low" and slope < -1e-3:
                    ttc = (val - m["crit"]) / -slope
                elif m["dir"] == "high" and slope > 1e-3 and val >= m["warn"] - 6:
                    # only near the warning band: a warming-up engine isn't "about to overheat"
                    ttc = (m["crit"] - val) / slope
            trend = "falling" if slope < -0.005 else "rising" if slope > 0.005 else "steady"
            channels.append({**{k: m[k] for k in ("key", "label", "unit", "dir", "warn", "crit", "max")},
                             "value": round(val + (self.rng.uniform(-0.3, 0.3) if m["unit"] == "°C" and self.engine_on else 0), 1),
                             "status": st, "trend": trend, "rate_per_min": round(slope * 60, 2),
                             "time_to_critical_s": None if ttc is None or ttc > 4 * 3600 else round(ttc),
                             "history": [h[key] for h in list(self.history)[-60:]]})
            if st in ("warn", "crit"):
                alerts.append({"key": key, "label": m["label"], "status": st, "value": round(val, 1), "unit": m["unit"],
                               "action": m["action"]})
            if st != self.status.get(key) and st in ("warn", "crit") and self.status.get(key) != "crit":
                transitions.append({"key": key, "label": m["label"], "status": st, "value": round(val, 1), "unit": m["unit"]})
            self.status[key] = st

        # Anomaly rules: loss much faster than normal consumption = leak, etc.
        hyd = self._slope("hydraulic_oil")
        if hyd < -0.05:
            anomalies.append({"key": "hydraulic_oil", "title": "Abnormal hydraulic oil loss: likely leak",
                              "detail": f"Level falling {abs(hyd) * 60:.1f}%/min, about {abs(hyd) / 0.0008:.0f}× normal consumption. "
                                        "Check boom/stick cylinder seals and hose fittings."})
        oil = self._slope("engine_oil")
        if oil < -0.05:
            anomalies.append({"key": "engine_oil", "title": "Engine oil loss: possible leak",
                              "detail": f"Oil level falling {abs(oil) * 60:.1f}%/min. Inspect sump, filter housing and gaskets."})
        cool, tmp = self._slope("coolant"), self._slope("engine_temp")
        if cool < -0.02 and tmp > 0.02:
            anomalies.append({"key": "coolant", "title": "Coolant loss with rising temperature: overheating risk",
                              "detail": "Coolant dropping while engine temperature climbs. Check radiator, hoses and water pump."})
        air = self._slope("air_filter")
        if air > 0.05:
            anomalies.append({"key": "air_filter", "title": "Air filter clogging fast",
                              "detail": f"Restriction rising {air * 60:.1f}%/min: dusty conditions or a damaged pre-cleaner."})

        order = {"ok": 0, "off": 0, "warn": 1, "crit": 2}
        worst = max((c["status"] for c in channels), key=lambda s: order[s])
        overall = {"ok": "ok", "off": "ok", "warn": "warn", "crit": "crit"}[worst]
        block = None
        if self.v["engine_oil"] < META["engine_oil"]["crit"]:
            block = "Engine oil critically low"
        elif self.v["coolant"] < META["coolant"]["crit"]:
            block = "Coolant critically low"
        elif self.v["fuel"] <= 1:
            block = "Fuel tank empty"
        n = len(self.history)
        conf = confidence(
            0.55 + 0.35 * min(1, n / 30),
            "Sensor thresholds + least-squares trend + consumption-rate anomaly rules",
            [f"{n} samples in the last {n * SAMPLE_EVERY_S / 60:.1f} min at {SAMPLE_EVERY_S:.0f}-s intervals",
             "Time-to-critical from a linear trend over the last 20 s",
             "Leak rule: loss rate > 60× normal consumption"],
            ["Sensor values are simulated for the demo (no CAN-bus connection)",
             "Linear extrapolation assumes the current rate continues"])
        idle_now = time.time() - self.idle_since if self.idle_since else 0.0
        util = {"engine_s": round(self.engine_s), "work_s": round(self.work_s), "idle_s": round(self.idle_s),
                "fuel_l": round(self.fuel_l, 2), "idle_fuel_l": round(self.idle_fuel_l, 2),
                "idle_now_s": round(idle_now), "idle_now_fuel_l": round(self.episode_fuel_l if self.idle_since else 0.0, 3),
                "idle_since": self.idle_since, "idle_episodes": self.idle_episodes,
                "longest_idle_s": round(max(self.longest_idle_s, idle_now)),
                "idle_lph": self.idle_lph, "work_lph": self.work_lph}
        return {
            "machine_id": self.machine_id, "engine_on": self.engine_on, "working": self.working, "utilisation": util,
            "overall": overall, "channels": channels, "alerts": alerts, "anomalies": anomalies,
            "transitions": transitions, "faults": [{"key": k, "label": FAULTS[k]} for k in sorted(self.faults)],
            "start_allowed": block is None, "block_reason": block, "confidence": conf,
        }


class HealthRegistry:
    def __init__(self, machine_ids):
        self.ids = list(machine_ids)
        self.reset()

    def reset(self):
        self.m = {mid: MachineHealth(mid) for mid in self.ids}

    def get(self, mid):
        return self.m[mid]
