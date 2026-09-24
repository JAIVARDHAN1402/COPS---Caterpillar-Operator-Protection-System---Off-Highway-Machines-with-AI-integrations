"""Supervisor notifications: SMS + WhatsApp.

Channels and providers (first configured wins per channel), set in backend/.env:
  SMS       Fast2SMS: FAST2SMS_API_KEY
            Twilio:   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
  WhatsApp  CallMeBot (free, personal numbers): CALLMEBOT_API_KEY
            Twilio WhatsApp: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
  If a channel has no provider it runs "simulated": the message is built and logged
  in the outbox (visible in the Supervisor Console and Shift Report) but not sent.
Recipients: COPS_SMS_TO (and optionally COPS_WHATSAPP_TO; defaults to the SMS number).

Delivery runs on background threads so API calls never wait on a gateway. Duplicate
alerts are suppressed for DEDUPE_S seconds and volume is capped per hour per channel.
"""
import base64
import datetime as dt
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
DEDUPE_S = 120
HOURLY_CAP = int(os.environ.get("COPS_SMS_HOURLY_CAP", "30"))
SMS_MAX = 480  # 3 SMS segments


def load_env():
    """Minimal .env loader (KEY=VALUE lines) so no extra dependency is needed."""
    if not ENV_PATH.exists():
        return
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()


def normalize(number):
    """10-digit Indian mobile -> +91XXXXXXXXXX; otherwise keep the country code."""
    d = re.sub(r"\D", "", number or "")
    if len(d) == 10:
        return "+91" + d
    if len(d) == 12 and d.startswith("91"):
        return "+" + d
    return "+" + d if d else ""


def _numbers(env_value):
    return [n for n in (normalize(x) for x in (env_value or "").split(",")) if len(n) >= 11]


class Notifier:
    def __init__(self):
        self.lock = threading.Lock()
        self.outbox = deque(maxlen=200)
        self.last_key = {}
        self.sent_times = {"sms": deque(), "whatsapp": deque()}
        self.to = _numbers(os.environ.get("COPS_SMS_TO", ""))
        self.wa_to = _numbers(os.environ.get("COPS_WHATSAPP_TO", "")) or list(self.to)
        self.counter = 0

    # ---------------------------------------------------------------- config
    @property
    def provider(self):  # SMS provider (kept for backwards compatibility)
        if os.environ.get("FAST2SMS_API_KEY"):
            return "fast2sms"
        if all(os.environ.get(k) for k in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM")):
            return "twilio"
        return "simulated"

    @property
    def wa_provider(self):
        if os.environ.get("CALLMEBOT_API_KEY"):
            return "callmebot"
        if all(os.environ.get(k) for k in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM")):
            return "twilio"
        return "simulated"

    def set_recipients(self, numbers):
        with self.lock:
            self.to = _numbers(",".join(numbers))
            self.wa_to = list(self.to)
        return self.to

    def status(self):
        now = time.time()
        recent = lambda ch: sum(1 for t in self.sent_times[ch] if now - t < 3600)  # noqa: E731
        return {"provider": self.provider, "live": self.provider != "simulated",
                "wa_provider": self.wa_provider, "wa_live": self.wa_provider != "simulated",
                "to": self.to, "wa_to": self.wa_to,
                "sent_last_hour": recent("sms"), "wa_sent_last_hour": recent("whatsapp"),
                "hourly_cap": HOURLY_CAP, "dedupe_s": DEDUPE_S}

    # ---------------------------------------------------------------- send
    def send(self, text, severity="HIGH", key=None, kind="alert", channels=("sms",), wa_text=None, machine_id=None):
        """Queue an alert on one or more channels. Returns the list of outbox entries ([] if suppressed)."""
        now = time.time()
        with self.lock:
            if key and now - self.last_key.get(key, 0) < DEDUPE_S:
                return []
            if key:
                self.last_key[key] = now
            entries = []
            for ch in channels:
                q = self.sent_times[ch]
                while q and now - q[0] > 3600:
                    q.popleft()
                self.counter += 1
                body = " ".join(text.split())[:SMS_MAX] if ch == "sms" else (wa_text or text)
                to = self.to if ch == "sms" else self.wa_to
                entry = {"id": f"{'SMS' if ch == 'sms' else 'WA'}{self.counter:04d}", "channel": ch,
                         "time": dt.datetime.now().isoformat(timespec="seconds"), "to": list(to), "text": body,
                         "severity": severity, "kind": kind, "machine_id": machine_id,
                         "provider": self.provider if ch == "sms" else self.wa_provider, "status": "queued", "detail": ""}
                if not to:
                    entry.update(status="failed", detail="No supervisor phone number configured")
                elif len(q) >= HOURLY_CAP:
                    entry.update(status="rate_limited", detail=f"Hourly cap of {HOURLY_CAP} reached")
                else:
                    q.append(now)
                self.outbox.appendleft(entry)
                entries.append(entry)
        for e in entries:
            if e["status"] == "queued":
                threading.Thread(target=self._deliver, args=(e,), daemon=True).start()
        return entries

    def _deliver(self, entry):
        try:
            p = entry["provider"]
            if p == "simulated":
                where = "FAST2SMS_API_KEY or Twilio keys" if entry["channel"] == "sms" else "CALLMEBOT_API_KEY or Twilio WhatsApp keys"
                entry.update(status="simulated", detail=f"No provider configured: add {where} to backend/.env")
                return
            if entry["channel"] == "sms":
                detail = self._fast2sms(entry) if p == "fast2sms" else self._twilio(entry, whatsapp=False)
            else:
                detail = self._callmebot(entry) if p == "callmebot" else self._twilio(entry, whatsapp=True)
            entry.update(status="sent", detail=detail)
        except urllib.error.HTTPError as e:
            entry.update(status="failed", detail=f"HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:200]}")
        except Exception as e:  # network down, DNS, timeout...
            entry.update(status="failed", detail=str(e)[:200])

    # ---------------------------------------------------------------- providers
    @staticmethod
    def _post(url, data, headers):
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode("utf-8") or "{}")

    def _fast2sms(self, entry):
        numbers = ",".join(n[-10:] for n in entry["to"])  # Fast2SMS takes 10-digit Indian numbers
        body = json.dumps({"route": "q", "message": entry["text"], "language": "english", "flash": 0,
                           "numbers": numbers}).encode()
        r = self._post("https://www.fast2sms.com/dev/bulkV2", body,
                       {"authorization": os.environ["FAST2SMS_API_KEY"], "Content-Type": "application/json"})
        if not r.get("return"):
            raise RuntimeError(f"Fast2SMS rejected: {r.get('message')}")
        return f"Fast2SMS request {r.get('request_id', '')}"

    def _twilio(self, entry, whatsapp):
        sid, token = os.environ["TWILIO_ACCOUNT_SID"], os.environ["TWILIO_AUTH_TOKEN"]
        auth = base64.b64encode(f"{sid}:{token}".encode()).decode()
        sender = os.environ["TWILIO_WHATSAPP_FROM"] if whatsapp else os.environ["TWILIO_FROM"]
        if whatsapp and not sender.startswith("whatsapp:"):
            sender = "whatsapp:" + sender
        ids = []
        for to in entry["to"]:
            data = urllib.parse.urlencode({"From": sender, "To": f"whatsapp:{to}" if whatsapp else to,
                                           "Body": entry["text"]}).encode()
            r = self._post(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json", data,
                           {"Authorization": f"Basic {auth}", "Content-Type": "application/x-www-form-urlencoded"})
            ids.append(r.get("sid", "?"))
        return "Twilio " + ", ".join(ids)

    def _callmebot(self, entry):
        """CallMeBot WhatsApp API (GET). The recipient activates it once from their own WhatsApp."""
        out = []
        for to in entry["to"]:
            q = urllib.parse.urlencode({"phone": to, "text": entry["text"], "apikey": os.environ["CALLMEBOT_API_KEY"]})
            with urllib.request.urlopen(f"https://api.callmebot.com/whatsapp.php?{q}", timeout=20) as r:
                body = r.read().decode("utf-8", "ignore")
            if "queued" not in body.lower() and "sent" not in body.lower():
                raise RuntimeError(f"CallMeBot: {re.sub('<[^>]+>', ' ', body)[:160].strip()}")
            out.append(to)
        return "CallMeBot queued for " + ", ".join(out)


SmsGateway = Notifier  # backwards-compatible name
