#!/usr/bin/env python3
"""Run bundled backend/tools with empty PATH using disposable marked fixture data only.

This proves packaged HTTP/lifecycle behavior and local BPM/key analysis on a
synthetic clip, not native WebView/codec playback.
"""
from __future__ import annotations
import argparse
import http.client
import json
import os
import queue
import re
import signal
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from verify_bundle import resource_root

# Integration calibrates these on the web runtime with the same synthetic clip.
EXPECTED_BPM_RANGE = (139, 141)
EXPECTED_KEY = "C major"
BPM_METHOD = "librosa-onset-multilag-v2"
# A C-major triad plus a decaying broadband click at 140 BPM. 270 s covers the
# 30/120/210 s sections that estimate_file_bpm reads.
CLIP_SECONDS = 270
CLIP_EXPRESSION = ("0.15*(sin(2*PI*261.63*t)+sin(2*PI*329.63*t)+sin(2*PI*392*t))"
                   "+0.5*(2*random(0)-1)*exp(-mod(t,60/140)/0.005)")
JOB_TIMEOUT_SECONDS = 300


def backend_environment(source: dict) -> dict:
    environment = {key: value for key, value in source.items()
                   if not key.upper().startswith(("CRATEMIND_", "PYTHON", "DYLD_", "NUMBA_", "LIBROSA_"))}
    environment["PATH"] = ""
    return environment


def synthesize_clip(ffmpeg: Path, destination: Path, environment: dict) -> None:
    source = f"aevalsrc=exprs='{CLIP_EXPRESSION}':s=44100:d={CLIP_SECONDS}"
    subprocess.run([str(ffmpeg), "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", source,
                    "-ac", "1", "-c:a", "pcm_s16le", str(destination)],
                   env=environment, capture_output=True, text=True, check=True, timeout=120)


class Backend:
    """One packaged backend launch with a fresh init, as the native shell does."""

    def __init__(self, executable: Path, data: Path, resources: Path, tools: dict, environment: dict, cwd: str, diagnostics: list):
        self.init = {"protocol_version":1,"launch_id":uuid.uuid4().hex,"session_secret":uuid.uuid4().hex+uuid.uuid4().hex,"paths":{"app_data":str(data),"resources":str(resources)},"tools":{name:str(path) for name,path in tools.items()},"runtime_profile":"desktop-core"}
        self.diagnostics = diagnostics
        self.events: queue.Queue = queue.Queue()
        self.process = subprocess.Popen([str(executable)], cwd=cwd, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=os.name != "nt")
        threading.Thread(target=self._stdout,daemon=True).start()
        threading.Thread(target=self._stderr,daemon=True).start()

    def start(self) -> None:
        self.send(self.init)
        bound=self.events.get(timeout=90)
        if bound.get("type")!="BOUND" or bound.get("launch_id")!=self.init["launch_id"]: raise RuntimeError("Invalid BOUND record")
        self.port=bound["port"]
        self.cookie={"Cookie":f"cratemind_{self.init['launch_id']}={self.init['session_secret']}"}
        deadline=time.monotonic()+90
        while True:
            if self.process.poll() is not None: raise RuntimeError("Packaged backend exited before readiness")
            try:
                if self.request("/api/desktop/health",{"X-CrateMind-Desktop-Secret":self.init["session_secret"]})[0]==200:break
            except OSError:pass
            if time.monotonic()>deadline:raise TimeoutError("Packaged backend readiness timed out")
            time.sleep(.1)

    def _stdout(self):
        for line in self.process.stdout:
            try: self.events.put(json.loads(line))
            except ValueError: self.events.put({"invalid":line[:300]})

    def _stderr(self):
        for line in self.process.stderr:
            self.diagnostics.append(line.replace(self.init["session_secret"],"[redacted]"))
            if len(self.diagnostics)>60: del self.diagnostics[0]

    def send(self, record: dict) -> None:
        self.process.stdin.write(json.dumps(record)+"\n");self.process.stdin.flush()

    def wait_event(self, matches, timeout: float) -> dict:
        deadline=time.monotonic()+timeout
        while True:
            try: event=self.events.get(timeout=max(.01,deadline-time.monotonic()))
            except queue.Empty: raise TimeoutError("Expected backend protocol record was not received") from None
            if "invalid" in event: raise RuntimeError(f"Invalid protocol output: {event['invalid']!r}")
            if matches(event): return event

    def request(self, path, headers=None, method="GET", body=None, timeout=2):
        connection=http.client.HTTPConnection("127.0.0.1",self.port,timeout=timeout)
        try:
            connection.request(method,path,body=body,headers=headers or {})
            response=connection.getresponse();payload=response.read()
            return response.status,dict(response.getheaders()),payload
        finally:connection.close()

    def get_json(self, path):
        status,_,body=self.request(path,self.cookie,timeout=10)
        if status!=200:raise RuntimeError(f"GET {path} failed: {status} {body[:300]!r}")
        return json.loads(body)

    def write(self, method, path, payload):
        # Mutations need the launch cookie and the exact loopback Origin (auth.py).
        headers={**self.cookie,"Origin":f"http://127.0.0.1:{self.port}","Content-Type":"application/json"}
        status,_,body=self.request(path,headers,method=method,body=json.dumps(payload),timeout=30)
        if status!=200:raise RuntimeError(f"{method} {path} failed: {status} {body[:300]!r}")
        return json.loads(body)

    def start_analysis(self) -> dict:
        # A finished job's child may still be exiting; the route answers 409 until it has.
        deadline=time.monotonic()+15
        while True:
            try: return self.write("POST","/api/scan/analyze",{"force":True})
            except RuntimeError as exc:
                if " 409 " not in str(exc) or time.monotonic()>deadline: raise
            time.sleep(.2)

    def wait_job(self, job_id: int) -> dict:
        deadline=time.monotonic()+JOB_TIMEOUT_SECONDS
        while True:
            job=self.get_json(f"/api/scan/status?job_id={job_id}")
            if job["status"] in {"done","error"}:return job
            if self.process.poll() is not None:raise RuntimeError("Packaged backend exited during a job")
            if time.monotonic()>deadline:raise TimeoutError(f"Job {job_id} did not finish: {job}")
            time.sleep(.5)

    def shutdown(self) -> None:
        self.send({"type":"SHUTDOWN","protocol_version":1,"launch_id":self.init["launch_id"]})

    def kill_tree(self) -> None:
        if os.name!="nt":
            try: os.killpg(self.process.pid,signal.SIGKILL)
            except ProcessLookupError: pass
        else:
            subprocess.run(["taskkill","/T","/F","/PID",str(self.process.pid)],capture_output=True)
        if self.process.poll() is None:self.process.wait(timeout=5)


def process_tree_gone(backend: Backend) -> bool:
    if os.name!="nt":
        try: os.killpg(backend.process.pid,0)
        except ProcessLookupError: return True
        return False
    listing=subprocess.run(["tasklist","/FI","IMAGENAME eq cratemind-backend.exe","/NH"],capture_output=True,text=True).stdout
    return "cratemind-backend.exe" not in listing.lower()


def analysed_track(backend: Backend) -> dict:
    tracks=backend.get_json("/api/tracks?limit=10")
    if len(tracks)!=1:raise RuntimeError(f"Expected one fixture track, found {len(tracks)}")
    track=tracks[0]
    bpm,method,key=track.get("bpm_analyzed"),track.get("bpm_analyzed_method"),track.get("key_analyzed")
    if bpm is None or not EXPECTED_BPM_RANGE[0]<=bpm<=EXPECTED_BPM_RANGE[1] or method!=BPM_METHOD or key!=EXPECTED_KEY:
        raise RuntimeError(f"Unexpected analysis: bpm={bpm} method={method} key={key}")
    return {"bpm":bpm,"confidence":track.get("bpm_analyzed_confidence"),"method":method,"key":key,"key_confidence":track.get("key_analyzed_confidence")}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    args = parser.parse_args()
    resources = resource_root(args.artifact.absolute())
    suffix = ".exe" if os.name == "nt" else ""
    executable = resources / "backend" / ("cratemind-backend" + suffix)
    environment = backend_environment(os.environ)
    tools = {name: resources / "tools" / (name + suffix) for name in ["ffmpeg", "ffprobe", "fpcalc"]}
    versions = {}
    for name, tool in tools.items():
        result = subprocess.run([str(tool), "-version"], env=environment, capture_output=True, text=True, check=True, timeout=30)
        versions[name] = (result.stdout or result.stderr).splitlines()[0]
    with tempfile.TemporaryDirectory(prefix="cratemind-installed-smoke-") as temporary:
        root = Path(temporary).resolve()
        data = root / "app-data"
        music = root / "music"
        data.mkdir();music.mkdir()
        (data / ".cratemind-qa-fixture").write_text("fixture only\n")
        diagnostics: list[str] = []
        backends: list[Backend] = []
        def launch() -> Backend:
            backend = Backend(executable, data, resources, tools, environment, temporary, diagnostics)
            backends.append(backend)
            backend.start()
            return backend
        try:
            backend=launch()
            if backend.request("/api/capabilities")[0]!=403:raise RuntimeError("Unauthenticated API was not rejected")
            capabilities=backend.get_json("/api/capabilities")
            if capabilities.get("analysis") is not True or capabilities.get("provider_workflows") is not False:raise RuntimeError(f"Unexpected desktop capabilities: analysis={capabilities.get('analysis')} provider_workflows={capabilities.get('provider_workflows')}")
            status,headers,body=backend.request("/",backend.cookie)
            if status!=200 or b"<html" not in body.lower():raise RuntimeError(f"Packaged frontend failed: {status}")
            if "content-security-policy" not in {key.lower() for key in headers}:raise RuntimeError("Missing CSP")
            synthesize_clip(tools["ffmpeg"], music / "smoke-140bpm-c-major.wav", environment)
            # Add the folder like DesktopLibrarySettings.tsx, then restart as the native shell does.
            config=backend.get_json("/api/desktop/config")
            folder=str(music)
            flavor="windows" if re.match(r"^[a-z]:[\\/]|^\\\\",folder,re.IGNORECASE) else "posix"
            updated=backend.write("PATCH","/api/desktop/config",{"library_roots":config["library_roots"]+[{"root_key":str(uuid.uuid4()),"logical_prefix":folder,"logical_flavor":flavor,"local_prefix":folder,"enabled":True}]})
            backend.wait_event(lambda e:e.get("type")=="NATIVE_REQUEST" and e.get("action")=="restart_for_config" and e.get("arguments",{}).get("revision")==updated["revision"],10)
            backend.shutdown()
            backend.wait_event(lambda e:e.get("type")=="SHUTDOWN_COMPLETE",15)
            backend.process.wait(timeout=10)
            if backend.process.returncode!=0:raise RuntimeError(f"Restart shutdown failed: {backend.process.returncode}")
            backend=launch()
            # (a) A desktop scan analyses the added track locally (cold run in this app_data).
            start=time.monotonic()
            job=backend.wait_job(backend.write("POST","/api/scan/start",{})["id"])
            if job["status"]!="done":raise RuntimeError(f"Scan failed: {job}")
            scan={"seconds":round(time.monotonic()-start,3),"job_message":job["message"],**analysed_track(backend)}
            # (b) The manual «Επανανάλυση» path, warm.
            start=time.monotonic()
            job=backend.wait_job(backend.start_analysis()["id"])
            if job["status"]!="done":raise RuntimeError(f"Manual analysis failed: {job}")
            manual={"seconds":round(time.monotonic()-start,3),"job_message":job["message"],**analysed_track(backend)}
            # (c) SHUTDOWN during analysis leaves no process behind.
            backend.start_analysis()
            start=time.monotonic();backend.shutdown();backend.process.wait(timeout=15)
            deadline=time.monotonic()+5
            while not process_tree_gone(backend):
                if time.monotonic()>deadline:raise RuntimeError("Analysis processes outlived the backend")
                time.sleep(.1)
            interrupted={"seconds":round(time.monotonic()-start,3),"exit_code":backend.process.returncode,"process_tree":"gone"}
            # Test the EOF watchdog, which is also the hard host-crash recovery path.
            backend=launch()
            start=time.monotonic();backend.process.stdin.close();backend.process.wait(timeout=8)
            if backend.process.returncode!=0:raise RuntimeError(f"Backend exit failed: {backend.process.returncode}")
            print(json.dumps({"ok":True,"tools":versions,"authenticated_http":"passed","unauthenticated_api":403,"packaged_frontend":"passed","capabilities":{"analysis":True,"provider_workflows":False},"restart_for_config":"passed","scan_analysis":scan,"manual_analysis":manual,"shutdown_during_analysis":interrupted,"stdin_eof_exit_seconds":round(time.monotonic()-start,3),"fixture_only":True,"native_webview":"not exercised"},indent=2))
        except Exception as exc:
            raise RuntimeError(str(exc)+"\n"+"".join(diagnostics)) from exc
        finally:
            for backend in backends:
                if (backend.process.poll() is None or not process_tree_gone(backend)):
                    backend.kill_tree()
    return 0

if __name__ == "__main__":raise SystemExit(main())
