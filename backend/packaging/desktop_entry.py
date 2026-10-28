"""PyInstaller entry: no implicit web application is constructed."""
import multiprocessing

if __name__ == "__main__":
    multiprocessing.freeze_support()
    from app.desktop_runtime.bootstrap import main
    raise SystemExit(main())
