#!/usr/bin/env python3
"""Run bundled backend/tools with empty PATH using disposable marked fixture data only.

This proves packaged HTTP/lifecycle behavior, not native WebView/codec playback.
"""
from __future__ import annotations
import argparse
import http.client
import json
import os
import queue
import signal
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from verify_bundle import resource_root


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    args = parser.parse_args()
    resources = resource_root(args.artifact.absolute())
    suffix = ".exe" if os.name == "nt" else ""
    executable = resources / "backend" / ("cratemind-backend" + suffix)
    environment = {key: value for key, value in os.environ.items() if not key.upper().startswith(("CRATEMIND_", "PYTHON", "DYLD_"))}
    environment["PATH"] = ""
    tools = {name: resources / "tools" / (name + suffix) for name in ["ffmpeg", "ffprobe", "fpcalc"]}
    versions = {}
    for name, tool in tools.items():
        result = subprocess.run([str(tool), "-version"], env=environment, capture_output=True, text=True, check=True, timeout=30)
        versions[name] = (result.stdout or result.stderr).splitlines()[0]
    with tempfile.TemporaryDirectory(prefix="cratemind-installed-smoke-") as temporary:
        data = Path(temporary)
        (data / ".cratemind-qa-fixture").write_text("fixture only\n")
        init = {"protocol_version":1,"launch_id":uuid.uuid4().hex,"session_secret":uuid.uuid4().hex+uuid.uuid4().hex,"paths":{"app_data":str(data),"resources":str(resources)},"tools":{name:str(path) for name,path in tools.items()},"runtime_profile":"desktop-core"}
        process = subprocess.Popen([str(executable)], cwd=temporary, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=os.name != "nt")
        events: queue.Queue = queue.Queue()
        diagnostics: list[str] = []
        def stdout():
            for line in process.stdout:
                try: events.put(json.loads(line))
                except ValueError: events.put({"invalid":line[:300]})
        def stderr():
            for line in process.stderr:
                diagnostics.append(line.replace(init["session_secret"],"[redacted]"))
                if len(diagnostics)>60: del diagnostics[0]
        threading.Thread(target=stdout,daemon=True).start()
        threading.Thread(target=stderr,daemon=True).start()
        try:
            process.stdin.write(json.dumps(init)+"\n");process.stdin.flush()
            bound=events.get(timeout=90)
            if bound.get("type")!="BOUND" or bound.get("launch_id")!=init["launch_id"]: raise RuntimeError("Invalid BOUND record")
            port=bound["port"]
            def request(path,headers=None):
                connection=http.client.HTTPConnection("127.0.0.1",port,timeout=2)
                try:
                    connection.request("GET",path,headers=headers or {})
                    response=connection.getresponse();body=response.read()
                    return response.status,dict(response.getheaders()),body
                finally:connection.close()
            deadline=time.monotonic()+90
            while True:
                if process.poll() is not None: raise RuntimeError("Packaged backend exited before readiness")
                try:
                    if request("/api/desktop/health",{"X-CrateMind-Desktop-Secret":init["session_secret"]})[0]==200:break
                except OSError:pass
                if time.monotonic()>deadline:raise TimeoutError("Packaged backend readiness timed out")
                time.sleep(.1)
            if request("/api/capabilities")[0]!=403:raise RuntimeError("Unauthenticated API was not rejected")
            cookie={"Cookie":f"cratemind_{init['launch_id']}={init['session_secret']}"}
            status,_,body=request("/api/capabilities",cookie)
            if status!=200:raise RuntimeError(f"Capabilities failed: {status} {body[:300]!r}")
            capabilities=json.loads(body)
            if capabilities.get("analysis") is not False or capabilities.get("provider_workflows") is not False:raise RuntimeError("Desktop deferred features advertised")
            status,headers,body=request("/",cookie)
            if status!=200 or b"<html" not in body.lower():raise RuntimeError(f"Packaged frontend failed: {status}")
            if "content-security-policy" not in {key.lower() for key in headers}:raise RuntimeError("Missing CSP")
            # Test the EOF watchdog, which is also the hard host-crash recovery path.
            start=time.monotonic();process.stdin.close();process.wait(timeout=8)
            if process.returncode!=0:raise RuntimeError(f"Backend exit failed: {process.returncode}")
            print(json.dumps({"ok":True,"tools":versions,"authenticated_http":"passed","unauthenticated_api":403,"packaged_frontend":"passed","stdin_eof_exit_seconds":round(time.monotonic()-start,3),"fixture_only":True,"native_webview":"not exercised"},indent=2))
        except Exception as exc:
            raise RuntimeError(str(exc)+"\n"+"".join(diagnostics)) from exc
        finally:
            if process.poll() is None:
                if os.name!="nt":os.killpg(process.pid,signal.SIGKILL)
                else:process.kill()
                process.wait(timeout=5)
    return 0

if __name__ == "__main__":raise SystemExit(main())
