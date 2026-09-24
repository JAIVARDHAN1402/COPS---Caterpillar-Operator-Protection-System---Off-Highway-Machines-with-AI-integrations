"""ML models: explainable task-time prediction + explainable anomaly detection."""
import copy
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor, IsolationForest
from sklearn.metrics import mean_absolute_error
from sklearn.model_selection import train_test_split

from .data_gen import SKILLS, TASK_BASE_MIN, WEATHERS

def confidence(score, method, basis, caveats=()):
    """Uniform 'AI confidence report' attached to every AI output in the app."""
    score = max(0.05, min(0.95, float(score)))  # never claim certainty
    level = "High" if score >= 0.8 else "Medium" if score >= 0.6 else "Low"
    return {"score": round(score, 2), "level": level, "method": method,
            "basis": list(basis), "caveats": list(caveats)}


# Economics used to turn idling into money / carbon.
IDLE_FUEL_LPH = 3.5      # typical 20t excavator idle burn, litres/hour
DIESEL_INR_PER_L = 92.0
CO2_KG_PER_L = 2.68


class TimePredictor:
    """Gradient boosting with 10/50/90 quantiles and a factor-by-factor explanation."""

    def __init__(self):
        self.mae_history = []

    def _encode(self, df):
        X = pd.DataFrame({"machine_age": df["machine_age"].astype(float)})
        for t in TASK_BASE_MIN:
            X[f"t_{t}"] = (df["task_type"] == t).astype(int)
        for w in WEATHERS:
            X[f"w_{w}"] = (df["weather"] == w).astype(int)
        for s in SKILLS:
            X[f"s_{s}"] = (df["operator_skill"] == s).astype(int)
        return X

    def fit(self, df):
        X, y = self._encode(df), df["actual_min"].values
        Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=0)
        eval_model = GradientBoostingRegressor(n_estimators=250, max_depth=3, random_state=0)
        eval_model.fit(Xtr, ytr)
        mae = float(mean_absolute_error(yte, eval_model.predict(Xte)))
        # Baseline = the "estimated time" column the site uses today.
        baseline_mae = float(mean_absolute_error(df["actual_min"], df["estimated_min"]))

        params = dict(n_estimators=250, max_depth=3, random_state=0)
        mid = GradientBoostingRegressor(**params).fit(X, y)
        lo = GradientBoostingRegressor(loss="quantile", alpha=0.1, **params).fit(X, y)
        hi = GradientBoostingRegressor(loss="quantile", alpha=0.9, **params).fit(X, y)
        # Swap the new models in together (training can run in a background thread
        # while requests keep predicting with the previous version).
        self.mid, self.lo, self.hi = mid, lo, hi
        self.n_samples = len(df)
        self.df = df[["task_type", "weather", "operator_skill"]].copy()
        self._cache = {}
        self.mae_history.append({"samples": len(df), "mae": round(mae, 2)})
        self.stats = {"mae": round(mae, 2), "baseline_mae": round(baseline_mae, 2),
                      "samples": len(df), "history": self.mae_history[-20:]}
        return self.stats

    def _row(self, task_type, weather, skill, age):
        return pd.DataFrame([{"task_type": task_type, "weather": weather,
                              "operator_skill": skill, "machine_age": age}])

    def _p(self, *args):
        return float(self.mid.predict(self._encode(self._row(*args)))[0])

    def predict(self, task_type, weather, skill, age):
        # Same inputs -> same answer until the next retrain; the scheduler asks many times per request.
        key = (task_type, weather, skill, int(age))
        cache = getattr(self, "_cache", None)
        if cache is None:
            cache = self._cache = {}
        if key not in cache:
            cache[key] = self._predict(task_type, weather, skill, age)
        return copy.deepcopy(cache[key])

    def _predict(self, task_type, weather, skill, age):
        X = self._encode(self._row(task_type, weather, skill, age))
        pred = float(self.mid.predict(X)[0])
        low = min(float(self.lo.predict(X)[0]), pred)
        high = max(float(self.hi.predict(X)[0]), pred)

        # Explanation: move from ideal conditions to actual, one factor at a time.
        p0 = self._p(task_type, "Sunny", "Expert", 2)
        p1 = self._p(task_type, weather, "Expert", 2)
        p2 = self._p(task_type, weather, skill, 2)
        p3 = pred
        breakdown = [
            {"factor": f"{task_type} (ideal conditions)", "delta": round(p0, 1), "kind": "base"},
            {"factor": f"Weather: {weather}", "delta": round(p1 - p0, 1), "kind": "weather"},
            {"factor": f"Skill: {skill}", "delta": round(p2 - p1, 1), "kind": "skill"},
            {"factor": f"Machine age: {age} yrs", "delta": round(p3 - p2, 1), "kind": "age"},
        ]
        # Confidence: narrow uncertainty band + many similar past tasks = high confidence.
        d = self.df
        n_similar = int(((d.task_type == task_type) & (d.weather == weather) & (d.operator_skill == skill)).sum())
        rel_width = (high - low) / max(pred, 1)
        score = 0.98 - rel_width * 1.6 - (0.12 if n_similar < 10 else 0) - (0.1 if not 1 <= age <= 10 else 0)
        caveats = ["Weather is taken from the forecast; actual conditions may differ"]
        if n_similar < 10:
            caveats.append("Few similar past tasks for this exact combination")
        if not 1 <= age <= 10:
            caveats.append("Machine age outside the range seen in training data")
        conf = confidence(
            score, "Gradient-boosting quantile models (10th/50th/90th percentile)",
            [f"{n_similar} similar past tasks ({task_type}, {weather}, {skill})",
             f"80% range: {low:.0f}-{high:.0f} min (±{(high - low) / 2:.1f})",
             f"Model error on held-out tasks: ±{self.stats['mae'] if hasattr(self, 'stats') else '?'} min"],
            caveats)
        return {"predicted_min": round(pred, 1), "low_min": round(low, 1),
                "high_min": round(high, 1), "site_estimate_min": TASK_BASE_MIN[task_type],
                "breakdown": breakdown, "confidence": conf}


class AnomalyDetector:
    """IsolationForest for 'unusual vs fleet' + rules that explain *why*."""

    FEATURES = ["idling_min", "load_cycles", "fuel_used_l", "idle_per_cycle", "fuel_per_cycle"]

    def _features(self, df):
        f = df.copy()
        f["idle_per_cycle"] = f["idling_min"] / (f["load_cycles"] + 1)
        f["fuel_per_cycle"] = f["fuel_used_l"] / (f["load_cycles"] + 1)
        return f

    def fit(self, df):
        f = self._features(df)
        self.iforest = IsolationForest(contamination=0.1, random_state=0).fit(f[self.FEATURES])
        self.fleet_idle_ratio = float(f["idle_per_cycle"].median())
        return self

    def analyze(self, df):
        f = self._features(df)
        f["if_flag"] = self.iforest.predict(f[self.FEATURES]) == -1
        f["if_score"] = -self.iforest.score_samples(f[self.FEATURES])
        records = []
        for _, r in f.iterrows():
            reasons = []
            if r.idling_min > 45:
                reasons.append({"tag": "idling", "text": f"Excessive idling: {int(r.idling_min)} min in a 2-hour window"})
            if r.load_cycles <= 3 and r.idling_min > 30:
                ratio = r.idle_per_cycle / self.fleet_idle_ratio
                reasons.append({"tag": "idling", "text": f"Engine on but almost no work: {int(r.load_cycles)} load cycles ({ratio:.0f}x fleet idle ratio)"})
            if r.seatbelt == "Unfastened":
                reasons.append({"tag": "seatbelt", "text": "Seatbelt unfastened while machine running"})
            if r.if_flag and not reasons:
                reasons.append({"tag": "pattern", "text": "Unusual combination of fuel / cycles / idle vs fleet"})
            wasted_l = r.idling_min / 60 * IDLE_FUEL_LPH
            records.append({
                "timestamp": r.timestamp, "machine_id": r.machine_id, "operator_id": r.operator_id,
                "engine_hours": r.engine_hours, "fuel_used_l": r.fuel_used_l,
                "load_cycles": int(r.load_cycles), "idling_min": int(r.idling_min),
                "seatbelt": r.seatbelt, "anomaly": bool(reasons),
                "anomaly_score": round(float(r.if_score), 3), "reasons": reasons,
                "idle_fuel_l": round(wasted_l, 2),
                "idle_cost_inr": round(wasted_l * DIESEL_INR_PER_L),
            })
        return records

    @staticmethod
    def summarize(records):
        df = pd.DataFrame(records)
        if df.empty:
            return {}
        idle_l = df["idle_fuel_l"].sum()
        unf = df[df.seatbelt == "Unfastened"]
        fas = df[df.seatbelt == "Fastened"]
        # Key insight from the provided data: belt-off windows = high idle windows.
        insight = None
        if len(unf) and len(fas):
            ui, fi = unf.idling_min.mean(), fas.idling_min.mean()
            uc, fc = unf.load_cycles.mean(), fas.load_cycles.mean()
            insight = (f"When the seatbelt is unfastened, idling averages {ui:.0f} min vs {fi:.0f} min "
                       f"and load cycles drop to {uc:.1f} vs {fc:.1f}. This suggests the operator is "
                       f"leaving the cab with the engine running - a safety AND fuel problem.")
        days = df.timestamp.str[:10].nunique()
        rule_explained = df[df.anomaly].reasons.apply(lambda r: any(x["tag"] != "pattern" for x in r)).mean() if df.anomaly.any() else 1.0
        conf = confidence(
            0.5 + 0.25 * min(1, days / 14) + 0.12 * rule_explained,
            "IsolationForest (fleet-wide) + explainable safety/idle rules",
            [f"{len(df)} two-hour telemetry windows over {days} days",
             f"{rule_explained:.0%} of flags backed by a clear rule (idle, seatbelt)",
             "Fuel cost uses 3.5 L/h idle burn and ₹92/L diesel"],
            ["Idle fuel burn is an industry average, not measured per machine",
             "Telemetry is simulated from the provided sample rows"])
        return {
            "confidence": conf,
            "records": int(len(df)),
            "anomalies": int(df.anomaly.sum()),
            "unfastened": int(len(unf)),
            "excess_idle_events": int((df.idling_min > 45).sum()),
            "total_idle_min": int(df.idling_min.sum()),
            "idle_fuel_l": round(float(idle_l), 1),
            "idle_cost_inr": int(round(idle_l * DIESEL_INR_PER_L)),
            "idle_co2_kg": round(float(idle_l * CO2_KG_PER_L), 1),
            "avoidable_cost_inr": int(round(df[df.idling_min > 20].eval("(idling_min-20)/60").sum()
                                            * IDLE_FUEL_LPH * DIESEL_INR_PER_L)),
            "insight": insight,
        }
