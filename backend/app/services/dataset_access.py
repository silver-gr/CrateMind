"""Dataset lifetime ownership and process-local durable-operation admission."""
from __future__ import annotations

import json
import math
import os
import threading
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import BinaryIO, Self


class DatasetBusyError(RuntimeError):
    pass


class MaintenanceBusyError(DatasetBusyError):
    pass


class HeldLease:
    def __init__(self, stream: BinaryIO, dataset_root: Path, owner: str):
        self._stream = stream
        self.dataset_root = dataset_root
        self.owner = owner
        self._lock = threading.Lock()

    def release(self) -> None:
        with self._lock:
            if self._stream.closed:
                return
            try:
                if os.name == "nt":
                    import msvcrt
                    self._stream.seek(0)
                    msvcrt.locking(self._stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self._stream.fileno(), fcntl.LOCK_UN)
            finally:
                self._stream.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_exc) -> None:
        self.release()


class DatasetLease:
    @staticmethod
    def acquire(dataset_root: Path | str, owner: str) -> HeldLease:
        root = Path(dataset_root).expanduser().resolve(strict=True)
        stream = os.fdopen(os.open(root / ".dataset.lock", os.O_RDWR | os.O_CREAT, 0o600), "r+b")
        try:
            if os.name == "nt":
                import msvcrt
                stream.seek(0, os.SEEK_END)
                if stream.tell() == 0:
                    stream.write(b"\0")
                    stream.flush()
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            stream.close()
            raise DatasetBusyError("Η βιβλιοθήκη χρησιμοποιείται από άλλη εφαρμογή.") from exc
        # The first byte stays present for Windows' byte-range lock.
        try:
            stream.seek(0)
            stream.write(b"\0" + json.dumps({"pid": os.getpid(), "owner": owner}).encode())
            stream.truncate()
            stream.flush()
        except BaseException:
            stream.close()
            raise
        return HeldLease(stream, root, owner)


class MaintenanceGuard:
    def __init__(self, coordinator: MaintenanceCoordinator, token: str):
        self._coordinator = coordinator
        self._token = token
        self._released = False

    def release(self) -> None:
        with self._coordinator._condition:
            if self._released:
                return
            if self._coordinator._maintenance_owner != self._token:
                raise RuntimeError("Maintenance ownership changed")
            self._coordinator._maintenance_depth -= 1
            if self._coordinator._maintenance_depth == 0:
                self._coordinator._maintenance_owner = None
                self._coordinator._maintenance_context.set(None)
                self._coordinator._condition.notify_all()
            self._released = True

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_exc) -> None:
        self.release()


class OperationToken:
    """Admission reservation transferable to the thread that executes the work."""
    def __init__(self, coordinator: MaintenanceCoordinator, token: str):
        self._coordinator = coordinator
        self._token = token
        self._closed = False
        self._context = None

    def close(self) -> None:
        with self._coordinator._condition:
            if self._closed:
                return
            label, depth = self._coordinator._active[self._token]
            if depth == 1:
                del self._coordinator._active[self._token]
            else:
                self._coordinator._active[self._token] = (label, depth - 1)
            self._closed = True
            self._coordinator._condition.notify_all()

    def __enter__(self) -> Self:
        with self._coordinator._condition:
            if self._closed or self._context is not None:
                raise RuntimeError("Operation reservation is closed or already bound")
            self._context = self._coordinator._operation_context.set(self._token)
        return self

    def __exit__(self, *_exc) -> None:
        self._coordinator._operation_context.reset(self._context)
        self._context = None
        self.close()


class MaintenanceCoordinator:
    """Track whole logical operations, including nested services and job lifetimes.

    Maintenance owns admission only. create_backup remains the sole owner of its
    SQLite reservation. A timeout restores ordinary admission without cancelling
    an operation between its catalog commit and identity synchronization.
    """
    def __init__(self):
        self._condition = threading.Condition(threading.RLock())
        self._active: dict[str, tuple[str, int]] = {}
        self._operation_context: ContextVar[str | None] = ContextVar(
            f"dataset_operation_{id(self)}", default=None,
        )
        self._maintenance_context: ContextVar[str | None] = ContextVar(
            f"dataset_maintenance_{id(self)}", default=None,
        )
        self._maintenance_owner: str | None = None
        self._maintenance_depth = 0

    @property
    def active_operations(self) -> tuple[str, ...]:
        with self._condition:
            return tuple(label for label, _depth in self._active.values())

    @property
    def maintenance_active(self) -> bool:
        with self._condition:
            return self._maintenance_owner is not None

    def start_operation(self, label: str) -> OperationToken:
        """Reserve before thread submission; close if submission itself fails."""
        with self._condition:
            existing = self._operation_context.get()
            token = existing if existing in self._active else uuid.uuid4().hex
            if self._maintenance_owner is not None and token not in self._active:
                raise MaintenanceBusyError("Η βιβλιοθήκη είναι προσωρινά σε συντήρηση.")
            current_label, depth = self._active.get(token, (label, 0))
            self._active[token] = (current_label, depth + 1)
            return OperationToken(self, token)

    @contextmanager
    def operation(self, label: str) -> Iterator[None]:
        with self.start_operation(label):
            yield

    # A submitted job must enter this scope inside the executing job, through its
    # final identity synchronization; submission alone is not durable admission.
    background_job = operation

    def enter_maintenance(self, timeout_s: float = 8.0) -> MaintenanceGuard:
        if timeout_s < 0 or not math.isfinite(timeout_s):
            raise ValueError("timeout_s must be finite and non-negative")
        deadline = time.monotonic() + timeout_s
        with self._condition:
            token = self._maintenance_context.get()
            if token is not None and token == self._maintenance_owner:
                self._maintenance_depth += 1
                return MaintenanceGuard(self, token)
            if self._operation_context.get() in self._active:
                raise MaintenanceBusyError("Δεν επιτρέπεται συντήρηση μέσα σε ενεργή αλλαγή.")
            if self._maintenance_owner is not None:
                raise MaintenanceBusyError("Υπάρχει ήδη ενεργή συντήρηση της βιβλιοθήκης.")
            token = uuid.uuid4().hex
            self._maintenance_owner = token
            self._maintenance_depth = 1
            while self._active:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._maintenance_owner = None
                    self._maintenance_depth = 0
                    self._condition.notify_all()
                    raise MaintenanceBusyError("Η βιβλιοθήκη παραμένει απασχολημένη. Δοκιμάστε ξανά.")
                self._condition.wait(remaining)
            self._maintenance_context.set(token)
            return MaintenanceGuard(self, token)


maintenance_coordinator = MaintenanceCoordinator()
