#![cfg(unix)]
use cratemind_native::supervisor::{BackendConfig, RunningBackend};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    time::{Duration, Instant},
};
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new(body: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("cratemind-native-test-{}", uuid::Uuid::new_v4()));
        for directory in ["backend", "tools", "data"] {
            fs::create_dir_all(root.join(directory)).unwrap();
        }
        for tool in ["ffmpeg", "ffprobe", "fpcalc"] {
            fs::write(root.join("tools").join(tool), b"fixture").unwrap();
        }
        let program = root.join("backend/cratemind-backend");
        let python = if std::path::Path::new("/usr/bin/python3").exists() {
            "/usr/bin/python3"
        } else {
            "/usr/bin/env python3"
        };
        fs::write(&program,format!("#!{python}\nimport sys,json,time,os,threading\ni=json.loads(sys.stdin.readline())\n{body}\n")).unwrap();
        fs::set_permissions(program, fs::Permissions::from_mode(0o755)).unwrap();
        Self { root }
    }
    fn config(&self, millis: u64) -> BackendConfig {
        BackendConfig {
            app_data: self.root.join("data"),
            resources: self.root.clone(),
            startup_timeout: Duration::from_millis(millis),
            shutdown: None,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
const SERVER: &str = r#"
from http.server import HTTPServer,BaseHTTPRequestHandler
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200 if self.headers.get('X-CrateMind-Desktop-Secret')==i['session_secret'] else 401);self.end_headers()
 def log_message(self,*a):pass
s=HTTPServer(('127.0.0.1',0),H)
print(json.dumps(dict(type='BOUND',protocol_version=1,launch_id=i['launch_id'],port=s.server_port)),flush=True)
threading.Thread(target=s.serve_forever,daemon=True).start()
for line in sys.stdin:
 if json.loads(line).get('type')=='SHUTDOWN':break
s.shutdown()
"#;
#[test]
fn authenticated_readiness_and_graceful_stop() {
    let fixture = Fixture::new(SERVER);
    let mut running = RunningBackend::start(fixture.config(5000)).unwrap();
    assert!(running.origin.port().unwrap() > 0);
    assert_eq!(running.init.launch_id.len(), 32);
    running.stop();
    assert!(running.exited());
}
#[test]
fn bound_is_not_readiness() {
    let fixture=Fixture::new("print(json.dumps(dict(type='BOUND',protocol_version=1,launch_id=i['launch_id'],port=1)),flush=True)\ntime.sleep(30)");
    let start = Instant::now();
    assert!(RunningBackend::start(fixture.config(350)).is_err());
    assert!(start.elapsed() < Duration::from_secs(3));
}
#[test]
fn malformed_and_mismatched_launch_are_rejected() {
    for body in ["print('not json',flush=True)\ntime.sleep(30)","print(json.dumps(dict(type='BOUND',protocol_version=1,launch_id='other',port=1234)),flush=True)\ntime.sleep(30)"]{let fixture=Fixture::new(body);assert!(RunningBackend::start(fixture.config(3000)).is_err());}
}
#[test]
fn early_exit_does_not_wait_for_deadline() {
    let fixture = Fixture::new("sys.exit(7)");
    let start = Instant::now();
    assert!(RunningBackend::start(fixture.config(5000)).is_err());
    assert!(start.elapsed() < Duration::from_secs(3));
}
#[test]
fn oversized_stdout_is_rejected_without_unbounded_read() {
    let fixture = Fixture::new("sys.stdout.write('x'*300000);sys.stdout.flush();time.sleep(30)");
    assert!(RunningBackend::start(fixture.config(3000)).is_err());
}
#[test]
fn stderr_is_drained_while_waiting_for_bound() {
    let fixture = Fixture::new(&format!(
        "sys.stderr.write('fixture noise\\n'*20000);sys.stderr.flush()\n{SERVER}"
    ));
    let mut running = RunningBackend::start(fixture.config(8000)).unwrap();
    running.stop();
}

#[test]
fn occupied_unrelated_listener_cannot_fake_authentication() {
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let worker = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut bytes = [0; 4096];
                let _ = stream.read(&mut bytes);
                let _ = stream.write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    });
    let fixture=Fixture::new(&format!("print(json.dumps(dict(type='BOUND',protocol_version=1,launch_id=i['launch_id'],port={port})),flush=True)\ntime.sleep(30)"));
    assert!(RunningBackend::start(fixture.config(350)).is_err());
    worker.join().unwrap();
}
#[test]
fn cancellation_interrupts_startup() {
    use std::sync::{atomic::AtomicBool, Arc};
    let fixture = Fixture::new("time.sleep(30)");
    let mut config = fixture.config(90000);
    config.shutdown = Some(Arc::new(AtomicBool::new(true)));
    let start = Instant::now();
    assert!(RunningBackend::start(config).is_err());
    assert!(start.elapsed() < Duration::from_secs(2));
}
