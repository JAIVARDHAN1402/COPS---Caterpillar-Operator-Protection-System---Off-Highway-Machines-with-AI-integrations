"""Synthetic data generation.

The hackathon provides only 4 telemetry rows and 5 task rows - far too few to
train a model. We generate realistic synthetic data whose effects are
calibrated so the original rows fit the same patterns, and keep the original
rows inside the datasets.
"""
import datetime as dt
from pathlib import Path

import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

TASK_BASE_MIN = {
    "Earth Excavation": 60,
    "Trenching": 45,
    "Material Loading": 30,
    "Grading": 35,
    "Demolition": 90,
}
WEATHERS = ["Sunny", "Cloudy", "Windy", "Rainy"]
SKILLS = ["Expert", "Intermediate", "Beginner"]

# Effects calibrated so the 5 provided rows are reproduced within noise.
WEATHER_FACTOR = {"Sunny": 1.00, "Cloudy": 1.03, "Windy": 1.05, "Rainy": 1.06}
SKILL_FACTOR = {"Expert": 0.95, "Intermediate": 1.04, "Beginner": 1.34}
AGE_PER_YEAR = 0.015
EARTHWORK = {"Earth Excavation", "Trenching", "Grading"}

SEED_TASKS = [
    ("T001", "Earth Excavation", "Sunny", "Expert", 2, 60, 58),
    ("T002", "Trenching", "Rainy", "Intermediate", 4, 45, 52),
    ("T003", "Material Loading", "Cloudy", "Beginner", 3, 30, 42),
    ("T004", "Grading", "Sunny", "Expert", 5, 35, 33),
    ("T005", "Demolition", "Windy", "Intermediate", 6, 90, 105),
]

SEED_TELEMETRY = [
    ("2025-05-01 08:00:00", "EXC001", "OP1001", 1523.5, 5.2, 12, 30, "Fastened", "No"),
    ("2025-05-01 10:00:00", "EXC001", "OP1001", 1524.8, 3.8, 2, 55, "Unfastened", "Yes"),
    ("2025-05-01 14:00:00", "EXC001", "OP1001", 1526.5, 6.1, 10, 15, "Fastened", "No"),
    ("2025-05-02 09:00:00", "EXC001", "OP1001", 1530.2, 2.0, 1, 60, "Unfastened", "Yes"),
]

TASK_COLS = ["task_id", "task_type", "weather", "operator_skill", "machine_age",
             "estimated_min", "actual_min"]
TELEMETRY_COLS = ["timestamp", "machine_id", "operator_id", "engine_hours", "fuel_used_l",
                  "load_cycles", "idling_min", "seatbelt", "safety_alert"]


def true_duration(task_type, weather, skill, age):
    d = TASK_BASE_MIN[task_type] * WEATHER_FACTOR[weather] * SKILL_FACTOR[skill]
    d *= 1 + AGE_PER_YEAR * (age - 2)
    if weather == "Rainy" and task_type in EARTHWORK:
        d *= 1.03  # mud slows earthwork more than other tasks
    return d


def generate_tasks(n=900, seed=7):
    rng = np.random.default_rng(seed)
    rows = [dict(zip(TASK_COLS, r)) for r in SEED_TASKS]
    types = list(TASK_BASE_MIN)
    for i in range(n):
        t = rng.choice(types)
        w = rng.choice(WEATHERS, p=[0.4, 0.25, 0.15, 0.2])
        s = rng.choice(SKILLS, p=[0.35, 0.4, 0.25])
        age = int(rng.integers(1, 11))
        actual = true_duration(t, w, s, age) * rng.normal(1, 0.04)
        rows.append(dict(task_id=f"H{i:04d}", task_type=t, weather=w, operator_skill=s,
                         machine_age=age, estimated_min=TASK_BASE_MIN[t],
                         actual_min=round(float(actual), 1)))
    return pd.DataFrame(rows, columns=TASK_COLS)


# Each operator has a "habit profile" so the anomaly story is consistent:
# OP1001 (like the provided data) sometimes leaves the cab with engine running,
# but is IMPROVING after coaching (trend +1) - this drives the feedback-loop story.
# OP1003 is slowly getting worse (trend -1) so the coach has something to flag.
OPERATOR_HABITS = {
    "OP1001": {"machine": "EXC001", "bad_rate": 0.22, "hours0": 1530.2, "trend": 1},
    "OP1002": {"machine": "EXC002", "bad_rate": 0.04, "hours0": 842.0, "trend": 0},
    "OP1003": {"machine": "LDR001", "bad_rate": 0.12, "hours0": 3120.0, "trend": -1},
}


def generate_telemetry(days=14, seed=11, end=None):
    """Last `days` days up to yesterday, plus the 4 provided rows (original dates)."""
    rng = np.random.default_rng(seed)
    rows = [dict(zip(TELEMETRY_COLS, r)) for r in SEED_TELEMETRY]
    end = pd.Timestamp(end or dt.date.today())
    start = end - pd.Timedelta(days=days)
    for op, h in OPERATOR_HABITS.items():
        hours = h["hours0"]
        for d in range(days):
            day = start + pd.Timedelta(days=d)
            progress = d / (days - 1)
            rate = h["bad_rate"] * (1 + h["trend"] * (0.5 - progress) * 1.3)
            for hr in (8, 10, 13, 15):
                bad = rng.random() < rate
                if bad:
                    cycles = int(rng.integers(0, 4))
                    idle = int(rng.integers(45, 75))
                    belt = "Unfastened" if rng.random() < 0.8 else "Fastened"
                else:
                    cycles = int(rng.integers(8, 15))
                    idle = int(rng.integers(8, 32))
                    belt = "Fastened" if rng.random() > 0.03 else "Unfastened"
                fuel = 0.38 * cycles + idle * 0.055 + rng.normal(0, 0.3)
                hours += 2 * rng.uniform(0.75, 0.95)
                rows.append(dict(
                    timestamp=str(day + pd.Timedelta(hours=hr)),
                    machine_id=h["machine"], operator_id=op,
                    engine_hours=round(hours, 1), fuel_used_l=round(max(fuel, 0.5), 1),
                    load_cycles=cycles, idling_min=idle, seatbelt=belt,
                    safety_alert="Yes" if belt == "Unfastened" else "No"))
    df = pd.DataFrame(rows, columns=TELEMETRY_COLS)
    return df.sort_values("timestamp").reset_index(drop=True)


def ensure_data():
    DATA_DIR.mkdir(exist_ok=True)
    tasks_path = DATA_DIR / "task_history.csv"
    tel_path = DATA_DIR / "telemetry.csv"
    if not tasks_path.exists():
        generate_tasks().to_csv(tasks_path, index=False)
    # Telemetry is "the last 14 days", so regenerate when the calendar moves on.
    yesterday = str(dt.date.today() - dt.timedelta(days=1))
    if not tel_path.exists() or pd.read_csv(tel_path)["timestamp"].max()[:10] != yesterday:
        generate_telemetry().to_csv(tel_path, index=False)
    return tasks_path, tel_path


if __name__ == "__main__":
    for p in ensure_data():
        print("wrote", p)
