"""Frozen executable entry. Only explicit parent paths can select application data."""
from __future__ import annotations

import argparse
import contextlib
import json
import logging
import os
import sys
import threading
import time
from pathlib import Path

from .protocol import ParentProtocol, load_desktop_init, read_record


def run_helper(init: dict, args, protocol) -> int:
    from ..library_exchange.operations import apply_import, load_import_preview
    root = Path(init["paths"]["app_data"]).resolve()
    preview = load_import_preview(root, args.preview_id)
    metadata = json.loads((root / "exchange/previews" / args.preview_id / "desktop.json").read_text())
    if metadata["expires_at_unix"] <= time.time() or metadata["decision"] != args.decision:
        raise ValueError("Η προεπισκόπηση έληξε ή άλλαξε.")
    if args.decision == "replace" and args.local_digest != metadata["local_digest"]:
        raise ValueError("Μη έγκυρη επιβεβαίωση αντικατάστασης.")
    apply_import(preview, root, decision=args.decision, confirmation_digest=args.local_digest)
    protocol.emit("HELPER_RESULT", ok=True)
    return 0


def run_server(init: dict, protocol) -> int:
    from .config import configure_environment, resolve_desktop_paths
    from ..services.dataset_access import DatasetLease
    from ..library_exchange.operations import initialize_empty, recover_exchange_intent

    paths = resolve_desktop_paths(init)
    with DatasetLease.acquire(paths.app_data, "desktop-service") as lease:
        recover_exchange_intent(paths.app_data)
        initialize_empty(paths.app_data, lease=lease)
        configure_environment(init, paths)
        from .server import bind_loopback, create_desktop_app
        import uvicorn
        with contextlib.closing(bind_loopback()) as sock:
            port = sock.getsockname()[1]
            app = create_desktop_app(init, paths, protocol, lease, port)
            server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port,
                access_log=False, proxy_headers=False, timeout_graceful_shutdown=4,
                log_level="warning", ws="none"))
            finished = threading.Event()

            def shutdown():
                server.should_exit = True
                from ..services.media_tools import media_tools
                media_tools.stop_all()
                if not finished.wait(6):
                    os._exit(1)  # parent EOF must not leave an orphan writer

            def watch_parent():
                try:
                    while record := read_record(sys.stdin):
                        if record.get("type") == "SHUTDOWN":
                            if record.get("launch_id") != init["launch_id"]:
                                raise ValueError("Μη έγκυρο κλείσιμο συνεδρίας.")
                            break
                        protocol.receive(record)
                except (ValueError, OSError):
                    logging.getLogger(__name__).warning("parent_protocol_closed")
                finally:
                    protocol.close()
                    shutdown()

            threading.Thread(target=watch_parent, daemon=True, name="desktop-parent").start()
            protocol.emit("BOUND", launch_id=init["launch_id"], port=port)
            try:
                server.run(sockets=[sock])
            finally:
                from ..services.media_tools import media_tools
                media_tools.stop_all()
                try:
                    # Analysis children must not outlive the dataset lease.
                    from ..jobs import worker
                    worker.stop_analysis_processes(2)
                except Exception:  # never block shutdown
                    logging.getLogger(__name__).exception("analysis_stop_failed")
                from ..db import get_engine
                get_engine().dispose()
                from ..services.dataset_access import maintenance_coordinator
                if maintenance_coordinator.active_operations:
                    # Do not release the dataset lease while daemon jobs can
                    # still write. Rust reaps the whole owned process tree.
                    os._exit(1)
                finished.set()
            protocol.emit("SHUTDOWN_COMPLETE")
    return 0


def self_test() -> int:
    import sqlite3
    import tempfile
    from contextlib import closing
    from ..library_exchange.operations import initialize_empty
    from ..services.schema_contract import load_schema_contract
    with tempfile.TemporaryDirectory(prefix="cratemind-self-test-") as temporary:
        dataset = initialize_empty(temporary)
        # closing(): the sqlite3 context manager only commits; an open file blocks the temp-dir cleanup on Windows.
        with closing(sqlite3.connect(dataset.catalog_path)) as db:
            assert db.execute("SELECT json_extract('{\"v\":1}', '$.v')").fetchone()[0] == 1
            db.execute("SELECT * FROM track_search LIMIT 0")
            db.execute("PRAGMA foreign_keys=ON")
            assert db.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        forbidden = [name for name in ("scipy", "librosa", "essentia", "app.services.audio_analysis") if name in sys.modules]
        if forbidden:
            raise RuntimeError("Unexpected analysis dependencies")
        # The analysis child's DSP stack must import and JIT-compile in the frozen app.
        started = time.monotonic()
        import numpy as np
        from ..services import audio_analysis
        rate = audio_analysis.SAMPLE_RATE
        t = np.arange(30 * rate) / rate
        # A C-major triad plus a decaying broadband click at 140 BPM.
        clip = sum(np.sin(2 * np.pi * frequency * t) for frequency in (261.63, 329.63, 392.0)) * 0.15
        click = np.random.default_rng(0).uniform(-0.5, 0.5, int(0.03 * rate)) * np.exp(-np.arange(int(0.03 * rate)) / (0.005 * rate))
        for beat in np.arange(0, 30, 60 / 140):
            start = int(beat * rate)
            clip[start:start + click.size] += click[:clip.size - start]
        clip = clip.astype(np.float32)
        bpm, _raw, _confidence, method = audio_analysis.estimate_bpm(clip)
        key, _key_confidence = audio_analysis.estimate_key(clip)
        if audio_analysis.librosa is None or method != audio_analysis.BPM_METHOD or key is None:
            raise RuntimeError(f"Frozen analysis failed: method={method} key={key}")
        analysis = {"bpm": bpm, "key": key, "method": method, "seconds": round(time.monotonic() - started, 3)}
        print(json.dumps({"ok": True, "sqlite": sqlite3.sqlite_version,
                          "schema": load_schema_contract()["fingerprint"], "forbidden_imports": forbidden,
                          "analysis": analysis}))
    return 0


def main(argv=None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments[:1] == ["--exchange-cli"]:
        # Explicit local operator entry, never exposed through the WebView/native
        # action bridge. Allows first enrollment/adoption without system Python.
        from ..library_exchange.cli import main as exchange_main
        return exchange_main(arguments[1:])
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--desktop-helper", choices=["apply-exchange"])
    parser.add_argument("--preview-id")
    parser.add_argument("--decision", choices=["import", "replace"], default="import")
    parser.add_argument("--local-digest")
    args = parser.parse_args(arguments)
    if args.self_test:
        return self_test()
    protocol = ParentProtocol(sys.stdout)
    try:
        init = load_desktop_init(sys.stdin)
        # Domain diagnostics must not corrupt the framed stdout protocol.
        with contextlib.redirect_stdout(sys.stderr):
            if args.desktop_helper:
                return run_helper(init, args, protocol)
            return run_server(init, protocol)
    except Exception as exc:
        if args.desktop_helper:
            protocol.emit("HELPER_RESULT", ok=False, error=str(exc))
        else:
            print("Η υπηρεσία CrateMind δεν ξεκίνησε: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
