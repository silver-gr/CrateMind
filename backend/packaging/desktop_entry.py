"""PyInstaller entry: no implicit web application is constructed."""
import multiprocessing
import os
import sys

if __name__ == "__main__":
    if sys.argv[1:2] == ["--multiprocessing-fork"] and os.environ.get("CRATEMIND_CHILD_LOG_DIR"):
        # A spawned analysis child: keep its output, which Windows otherwise loses.
        from app.desktop_runtime.child_diagnostics import install
        install(os.environ["CRATEMIND_CHILD_LOG_DIR"])
    multiprocessing.freeze_support()
    from app.desktop_runtime.bootstrap import main
    raise SystemExit(main())
