use crate::{
    process_tree::OwnedProcess,
    protocol::{self, BackendEvent, DesktopInit, Paths},
};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

pub struct BackendConfig {
    pub app_data: PathBuf,
    pub resources: PathBuf,
    pub startup_timeout: Duration,
    pub shutdown: Option<Arc<AtomicBool>>,
}
pub struct RunningBackend {
    pub init: DesktopInit,
    pub origin: url::Url,
    process: OwnedProcess,
    pub stdin: Arc<Mutex<Box<dyn Write + Send>>>,
    pub events: mpsc::Receiver<Result<BackendEvent, String>>,
}
fn executable(root: &std::path::Path) -> PathBuf {
    root.join("backend").join(if cfg!(windows) {
        "cratemind-backend.exe"
    } else {
        "cratemind-backend"
    })
}
fn initialization(config: &BackendConfig) -> Result<DesktopInit, String> {
    let mut tools = HashMap::new();
    for name in ["ffmpeg", "ffprobe", "fpcalc"] {
        let path = config
            .resources
            .join("tools")
            .join(format!("{name}{}", if cfg!(windows) { ".exe" } else { "" }));
        if !path.is_file() {
            return Err(format!("Λείπει το εργαλείο {name}"));
        }
        tools.insert(name.into(), path);
    }
    Ok(DesktopInit {
        protocol_version: protocol::VERSION,
        launch_id: uuid::Uuid::new_v4().simple().to_string(),
        session_secret: format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        ),
        paths: Paths {
            app_data: config.app_data.clone(),
            resources: config.resources.clone(),
        },
        tools,
        runtime_profile: "desktop-core",
    })
}
fn spawn(init: &DesktopInit, arguments: &[&str]) -> Result<RunningBackend, String> {
    let executable = executable(&init.paths.resources);
    if !executable.is_file() {
        return Err("Λείπει η συσκευασμένη υπηρεσία βιβλιοθήκης".into());
    }
    let mut command = Command::new(executable);
    command.args(arguments).current_dir(&init.paths.app_data);
    // The packaged runtime receives paths only over stdin, never checkout .env configuration.
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("CRATEMIND_")
        {
            command.env_remove(key);
        }
    }
    let mut process =
        OwnedProcess::spawn(&mut command).map_err(|e| format!("Εκκίνηση υπηρεσίας: {e}"))?;
    let (mut stdin, stdout, stderr) = process.pipes();
    serde_json::to_writer(&mut stdin, init).map_err(|e| e.to_string())?;
    stdin.write_all(b"\n").map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    let (sender, events) = mpsc::sync_channel(128);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            // take() bounds allocation even if a broken child never writes a newline.
            let mut line = Vec::new();
            match reader
                .by_ref()
                .take((protocol::MAX_RECORD + 2) as u64)
                .read_until(b'\n', &mut line)
            {
                Ok(0) => break,
                Ok(_) if line.len() <= protocol::MAX_RECORD && line.ends_with(b"\n") => {
                    if sender.send(protocol::parse_event(&line)).is_err() {
                        break;
                    }
                }
                _ => {
                    let _ = sender.send(Err("Μη έγκυρη ροή υπηρεσίας".into()));
                    break;
                }
            }
        }
    });
    let redacted_secret = init.session_secret.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        loop {
            let mut chunk = Vec::new();
            match reader.by_ref().take(4096).read_until(b'\n', &mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(_) => eprint!(
                    "{}",
                    String::from_utf8_lossy(&chunk).replace(&redacted_secret, "[redacted]")
                ),
            }
        }
    });
    Ok(RunningBackend {
        init: init.clone(),
        origin: url::Url::parse("http://127.0.0.1/").unwrap(),
        process,
        stdin: Arc::new(Mutex::new(Box::new(stdin))),
        events,
    })
}
impl RunningBackend {
    pub fn start(config: BackendConfig) -> Result<Self, String> {
        let init = initialization(&config)?;
        let mut running = spawn(&init, &[])?;
        let deadline = Instant::now() + config.startup_timeout;
        let mut bound = false;
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_millis(600)))
            .build()
            .into();
        while Instant::now() < deadline {
            if config
                .shutdown
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::Acquire))
            {
                return Err("Η εκκίνηση ακυρώθηκε".into());
            }
            if let Some(code) = running.process.exited().map_err(|e| e.to_string())? {
                return Err(format!("Η υπηρεσία σταμάτησε κατά την εκκίνηση ({code})"));
            }
            match running.events.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(BackendEvent::BOUND {
                    protocol_version,
                    launch_id,
                    port,
                })) if !bound
                    && protocol_version == 1
                    && launch_id == init.launch_id
                    && port != 0 =>
                {
                    running.origin = url::Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
                    bound = true;
                }
                Ok(_) => return Err("Μη έγκυρη απάντηση εκκίνησης υπηρεσίας".into()),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("Η υπηρεσία έκλεισε τη σύνδεση".into())
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if bound {
                if let Ok(response) = agent
                    .get(running.origin.join("api/desktop/health").unwrap().as_str())
                    .header("X-CrateMind-Desktop-Secret", &init.session_secret)
                    .call()
                {
                    if response.status() == 200 {
                        return Ok(running);
                    }
                }
            }
        }
        Err(format!(
            "{} σε {} δευτερόλεπτα",
            if bound {
                "Η υπηρεσία δεν ολοκλήρωσε την προετοιμασία"
            } else {
                "Η υπηρεσία δεν άνοιξε σύνδεση"
            },
            config.startup_timeout.as_secs()
        ))
    }
    pub fn send(&self, record: &serde_json::Value) -> Result<(), String> {
        let mut writer = self
            .stdin
            .lock()
            .map_err(|_| "Αδυναμία επικοινωνίας με την υπηρεσία")?;
        serde_json::to_writer(&mut *writer, record).map_err(|e| e.to_string())?;
        writer
            .write_all(b"\n")
            .and_then(|_| writer.flush())
            .map_err(|e| e.to_string())
    }
    pub fn exited(&mut self) -> bool {
        self.process.exited().map(|s| s.is_some()).unwrap_or(true)
    }
    pub fn stop(&mut self) {
        let _ = self.send(&serde_json::json!({"type":"SHUTDOWN","protocol_version":1,"launch_id":self.init.launch_id}));
        let deadline = Instant::now() + Duration::from_secs(7);
        while Instant::now() < deadline && !self.exited() {
            thread::sleep(Duration::from_millis(40));
        }
        self.process.terminate(Duration::from_secs(1));
    }
}
pub fn apply_exchange(
    init: &DesktopInit,
    preview: &str,
    decision: &str,
    local_digest: Option<&str>,
    shutdown: Option<&AtomicBool>,
) -> Result<(), String> {
    let mut args = vec![
        "--desktop-helper",
        "apply-exchange",
        "--preview-id",
        preview,
        "--decision",
        decision,
    ];
    if let Some(digest) = local_digest {
        args.extend(["--local-digest", digest]);
    }
    let mut helper = spawn(init, &args)?;
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut result = None;
    while Instant::now() < deadline {
        if shutdown.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return Err("Η εισαγωγή διακόπηκε κατά το κλείσιμο".into());
        }
        match helper.events.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(BackendEvent::HelperResult {
                protocol_version: 1,
                ok,
                error,
            })) => {
                result = Some(if ok {
                    Ok(())
                } else {
                    Err(error.unwrap_or_else(|| "Η εισαγωγή απέτυχε".into()))
                });
            }
            Ok(_) => return Err("Μη έγκυρη απάντηση βοηθού εισαγωγής".into()),
            Err(_) => {}
        }
        if helper.exited() {
            return result
                .unwrap_or_else(|| Err("Ο βοηθός εισαγωγής σταμάτησε χωρίς αποτέλεσμα".into()));
        }
    }
    Err("Η εισαγωγή ξεπέρασε το χρονικό όριο".into())
}
