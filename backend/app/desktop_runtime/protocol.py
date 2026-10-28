"""Bounded line-delimited parent protocol. Secrets never go to stdout logs."""
from __future__ import annotations

import json
import re
import threading
import uuid
from pathlib import Path

MAX_RECORD_BYTES = 128 * 1024


def read_record(stream):
    line = stream.readline(MAX_RECORD_BYTES + 1)
    if not line:
        return None
    if len(line.encode() if isinstance(line, str) else line) > MAX_RECORD_BYTES:
        raise ValueError("Υπερβολικά μεγάλο μήνυμα εκκίνησης.")
    value = json.loads(line)
    if not isinstance(value, dict) or value.get("protocol_version") != 1:
        raise ValueError("Μη συμβατή έκδοση επικοινωνίας.")
    return value


def load_desktop_init(stream) -> dict:
    value = read_record(stream)
    if value is None or value.get("runtime_profile") != "desktop-core":
        raise ValueError("Λείπει η διαμόρφωση της εφαρμογής.")
    if not re.fullmatch(r"[a-f0-9]{32}", value.get("launch_id", "")):
        raise ValueError("Μη έγκυρο αναγνωριστικό εκκίνησης.")
    secret = value.get("session_secret")
    if not isinstance(secret, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", secret):
        raise ValueError("Μη έγκυρη συνεδρία εφαρμογής.")
    for name in ("app_data", "resources"):
        if not Path(value.get("paths", {}).get(name, "")).is_absolute():
            raise ValueError("Απαιτούνται απόλυτες διαδρομές εφαρμογής.")
    for name in ("ffmpeg", "ffprobe", "fpcalc"):
        tool = Path(value.get("tools", {}).get(name, ""))
        if not tool.is_absolute() or not tool.is_file():
            raise ValueError(f"Λείπει το ενσωματωμένο εργαλείο {name}.")
    return value


class ParentProtocol:
    def __init__(self, output):
        self.output = output
        self._lock = threading.Lock()
        self._pending: dict[str, tuple[threading.Event, dict]] = {}

    def emit(self, kind: str, **values) -> None:
        record = {"type": kind, "protocol_version": 1, **values}
        encoded = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode()) > MAX_RECORD_BYTES:
            raise ValueError("Υπερβολικά μεγάλο μήνυμα εφαρμογής.")
        with self._lock:
            self.output.write(encoded + "\n")
            self.output.flush()

    def receive(self, record: dict) -> None:
        if record.get("type") != "NATIVE_RESULT":
            raise ValueError("Μη αναμενόμενο μήνυμα εφαρμογής.")
        with self._lock:
            pending = self._pending.get(record.get("id"))
            if pending is not None:
                pending[1].update(record)
                pending[0].set()

    def request(self, action: str, arguments: dict, timeout_s: float = 120) -> dict:
        request_id = uuid.uuid4().hex
        event, result = threading.Event(), {}
        with self._lock:
            self._pending[request_id] = (event, result)
        try:
            self.emit("NATIVE_REQUEST", id=request_id, action=action, arguments=arguments)
            if not event.wait(timeout_s):
                raise TimeoutError("Η ενέργεια δεν ολοκληρώθηκε εγκαίρως.")
            if result.get("error"):
                raise ValueError(str(result["error"]))
            return {"canceled": bool(result.get("canceled")), "value": result.get("value")}
        finally:
            with self._lock:
                self._pending.pop(request_id, None)

    def notify(self, action: str, arguments: dict) -> None:
        self.emit("NATIVE_REQUEST", id=uuid.uuid4().hex, action=action, arguments=arguments)

    def close(self) -> None:
        with self._lock:
            for event, result in self._pending.values():
                result["error"] = "Η εφαρμογή έκλεισε."
                event.set()
