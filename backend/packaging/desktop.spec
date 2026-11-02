# Build with the isolated desktop environment (core + local BPM/key DSP: librosa, SciPy,
# numba, llvmlite), never the web environment. Essentia and the provider/web-only modules
# stay excluded; local analysis runs only in the spawned analysis child. scikit-learn (only
# librosa.segment/decompose) and numba's OpenMP/TBB threading layers (unused; their runtimes
# are not bundled, numba falls back to its workqueue layer) are excluded too.
from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

backend = Path(SPECPATH).parent
hidden = collect_submodules("app", filter=lambda name: not any(
    name == prefix or name.startswith(prefix + ".") for prefix in (
        "app.main", "app.api.analysis", "app.api.soundcloud",
        "app.services.reccobeats", "app.services.getsongbpm",
    )))
a = Analysis([str(backend / "packaging/desktop_entry.py")], pathex=[str(backend)],
    binaries=[], datas=[(str(backend / "app/schema_contract.json"), "app"),
                       (str(backend / "app/desktop_runtime/deno_schema_contract.json"), "app/desktop_runtime")],
    hiddenimports=hidden + ["uvicorn.logging", "uvicorn.loops.asyncio", "uvicorn.protocols.http.h11_impl", "uvicorn.lifespan.on"],
    hookspath=[], excludes=["essentia", "sklearn", "numba.np.ufunc.omppool", "numba.np.ufunc.tbbpool", "tkinter", "pytest", "app.main", "app.api.analysis", "app.api.soundcloud", "app.services.reccobeats", "app.services.getsongbpm"],
    noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="cratemind-backend",
          console=True, debug=False, strip=False, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="cratemind-backend")
