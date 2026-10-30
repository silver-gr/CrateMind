pub mod midi;
pub mod native_actions;
pub mod process_tree;
pub mod protocol;
pub mod qa;
pub mod security;
pub mod storage;
pub mod supervisor;

use protocol::BackendEvent;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Manager, WebviewUrl, WebviewWindowBuilder,
};

struct Host {
    stop: Arc<AtomicBool>,
    retry: AtomicBool,
}
struct Diagnostic(Mutex<Option<String>>);
fn diagnostic(window: &tauri::WebviewWindow, allowed: &security::AllowedOrigin, message: &str) {
    eprintln!("CrateMind startup diagnostic: {message}");
    if window.state::<Arc<Host>>().stop.load(Ordering::Acquire) { return; }
    *allowed.lock().unwrap() = None;
    *window.state::<Diagnostic>().0.lock().unwrap() = Some(message.into());
    // Only bundled document receives diagnostic markup; JSON quoting prevents script interpolation.
    let _ = window.navigate(tauri::Url::parse("tauri://localhost/index.html").unwrap());
    let _ = window.show();
}
fn menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let retry = MenuItem::with_id(app, "retry", "Επανάληψη εκκίνησης", true, None::<&str>)?;
    let app_menu = Submenu::with_items(
        app,
        "CrateMind",
        true,
        &[
            &retry,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Έξοδος"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Επεξεργασία",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("Αναίρεση"))?,
            &PredefinedMenuItem::redo(app, Some("Επανάληψη"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("Αποκοπή"))?,
            &PredefinedMenuItem::copy(app, Some("Αντιγραφή"))?,
            &PredefinedMenuItem::paste(app, Some("Επικόλληση"))?,
            &PredefinedMenuItem::select_all(app, Some("Επιλογή όλων"))?,
        ],
    )?;
    let screens = Submenu::new(app, "Οθόνες", true)?;
    for (path, name) in [
        ("dashboard", "Πίνακας"),
        ("library", "Βιβλιοθήκη"),
        ("artists", "Καλλιτέχνες"),
        ("crates", "Crates"),
        ("playlists", "Playlists"),
        ("smart-folders", "Έξυπνοι φάκελοι"),
        ("tag", "Ουρά tagging"),
        ("sets", "Χτίσιμο set"),
        ("flow", "Flow Finder"),
        ("energy-maps", "Energy Maps"),
        ("key-harmony", "Key & Harmony"),
        ("tag-cloud", "Tag Cloud"),
        ("phrase-finder", "Phrase Finder"),
        ("duplicates", "Διπλότυπα"),
        ("unified", "Ενοποιημένη βιβλιοθήκη"),
        ("canonical", "Canonical metadata"),
        ("collections", "Συλλογές"),
        ("provenance", "Προέλευση"),
        ("recovery", "Ανάκτηση"),
        ("settings", "Ρυθμίσεις"),
    ] {
        screens.append(&MenuItem::with_id(
            app,
            format!("nav:{path}"),
            name,
            true,
            None::<&str>,
        )?)?;
    }
    Menu::with_items(app, &[&app_menu, &edit, &screens])
}

pub fn run() {
    let allowed: security::AllowedOrigin = Arc::new(Mutex::new(None));
    let navigation = allowed.clone();
    let builder = tauri::Builder::default()
        // Ownership plugin must be first; second launches only focus the existing main window.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| { if let Some(window) = app.get_webview_window("main") { let _ = window.unminimize(); let _ = window.show(); let _ = window.set_focus(); } }))
        .setup(move |app| {
            let data = storage::app_data(app.handle()).map_err(std::io::Error::other)?;
            let resources = app.path().resource_dir()?;
            let host = Arc::new(Host { stop: Arc::new(AtomicBool::new(false)), retry: AtomicBool::new(false) });
            app.manage(host.clone());
            app.manage(Diagnostic(Mutex::new(None)));
            let loaded = Arc::new(AtomicBool::new(false));
            let page_loaded = loaded.clone();
            // Separate from the backend page flag used by native QA below.
            let startup_loaded = Arc::new(AtomicBool::new(false));
            let startup_page_loaded = startup_loaded.clone();
            let startup_theme = storage::load_theme(&data);
            let startup_background = if startup_theme == "light" { tauri::window::Color(244, 243, 240, 255) } else { tauri::window::Color(9, 11, 23, 255) };
            app.set_menu(menu(app.handle())?)?;
            let nav_for_menu = navigation.clone();
            app.on_menu_event(move |app, event| {
                if event.id().as_ref() == "retry" { app.state::<Arc<Host>>().retry.store(true, Ordering::Release); }
                if let Some(route) = event.id().as_ref().strip_prefix("nav:") {
                    if let Some(origin) = nav_for_menu.lock().ok().and_then(|g| g.clone()) { if let Some(window) = app.get_webview_window("main") { if let Ok(url) = origin.join(route) { let _ = window.navigate(url); } } }
                }
            });
            let nav_hook = navigation.clone();
            let page_origin = navigation.clone();
            let mut window_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("CrateMind").visible(false).inner_size(1440.0, 900.0).min_inner_size(800.0, 600.0)
                .background_color(startup_background)
                .devtools(false)
                .initialization_script(format!(r#"(() => {{
                    const url = new URL(location.href);
                    const bundled = ((url.protocol === 'tauri:' && url.hostname === 'localhost') || (['http:', 'https:'].includes(url.protocol) && url.hostname === 'tauri.localhost')) && !url.port && !url.username && !url.password && ['', '/', '/index.html'].includes(url.pathname) && !url.search && !url.hash;
                    if (!bundled) return;
                    const apply = () => {{ if (!document.documentElement) return false; document.documentElement.dataset.theme = '{startup_theme}'; return true; }};
                    if (!apply()) {{ const observer = new MutationObserver(() => {{ if (apply()) observer.disconnect(); }}); observer.observe(document, {{ childList: true, subtree: true }}); }}
                }})();"#))
                .initialization_script("document.addEventListener('keydown',e=>{if(e.key==='F5'||e.key==='F12'||((e.ctrlKey||e.metaKey)&&((e.key.toLowerCase()==='r')||(e.shiftKey&&['i','j','c'].includes(e.key.toLowerCase()))))){e.preventDefault();e.stopImmediatePropagation()}},true)")
                .on_navigation(move |url| {
                    if security::allow_navigation(url, &nav_hook) { true } else {
                        if nav_hook.lock().ok().and_then(|g|g.clone()).is_some() { let _ = native_actions::open_external(url.as_str()); }
                        false
                    }
                })
                .on_new_window(|url, _| { let _ = native_actions::open_external(url.as_str()); tauri::webview::NewWindowResponse::Deny })
                .on_page_load(move |window, event| {
                    if window.state::<Arc<Host>>().stop.load(Ordering::Acquire) { return; }
                    if event.event() == tauri::webview::PageLoadEvent::Finished {
                        if page_origin.lock().ok().and_then(|g|g.clone()).is_some_and(|origin| security::same_origin(event.url(), &origin)) { page_loaded.store(true, Ordering::Release); let _ = window.show(); }
                        else if security::is_startup_document(event.url()) {
                            if let Some(message) = window.state::<Diagnostic>().0.lock().unwrap().as_ref() {
                                let text = serde_json::to_string(message).unwrap();
                                let _ = window.eval(format!("document.body.dataset.state='error';document.getElementById('startup-title').textContent='Η εκκίνηση δεν ολοκληρώθηκε';document.getElementById('startup-message').textContent={text};document.getElementById('startup-detail').hidden=true;document.getElementById('startup-retry').hidden=false"));
                            }
                            let _ = window.show();
                            startup_page_loaded.store(true, Ordering::Release);
                            eprintln!("CrateMind startup phase: loading-document-ready");
                        }
                    }
                });
            #[cfg(target_os = "macos")]
            {
                app.add_capability(security::window_drag_capability(None).map_err(std::io::Error::other)?)?;
                window_builder = window_builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .initialization_script(r#"(() => {
                        const apply = () => { if (!document.documentElement) return false; document.documentElement.dataset.nativeTitlebar = 'overlay'; return true; };
                        if (!apply()) { const observer = new MutationObserver(() => { if (apply()) observer.disconnect(); }); observer.observe(document, { childList: true, subtree: true }); }
                    })();"#);
            }
            let geometry = storage::load_geometry(&data);
            if let Some(value) = geometry.as_ref() { window_builder = window_builder.maximized(value.maximized); }
            let window = window_builder.build()?;
            if let Some(value) = geometry {
                let _ = window.set_size(tauri::PhysicalSize::new(value.width,value.height));
                let attached = app.available_monitors()?.iter().any(|m| { let p=m.position(); let size=m.size(); value.x < p.x+size.width as i32 && value.x+value.width as i32 > p.x && value.y < p.y+size.height as i32 && value.y+value.height as i32 > p.y });
                if attached { let _ = window.set_position(tauri::PhysicalPosition::new(value.x,value.y)); } else { let _ = window.center(); }
            }
            let save_window = window.clone(); let save_data = data.clone();
            let close_host = host.clone(); let handle = app.handle().clone();
            window.on_window_event(move |event| match event {
                tauri::WindowEvent::CloseRequested { api, .. } => { api.prevent_close(); storage::save_geometry(&save_data, &save_window); close_host.stop.store(true, Ordering::Release); let _ = save_window.hide(); },
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => storage::save_geometry(&save_data, &save_window),
                _ => {},
            });
            // Show the bundled loading page at the restored geometry before backend preparation.
            window.show()?;
            let midi_thread = midi::spawn(window.clone(), host.stop.clone(), navigation.clone(), loaded.clone());
            let loop_origin = navigation.clone();
            std::thread::spawn(move || {
                let config = || supervisor::BackendConfig { app_data: data.clone(), resources: resources.clone(), startup_timeout: Duration::from_secs(300), shutdown: Some(host.stop.clone()) };
                let mut first_start = true;
                loop {
                    if host.stop.load(Ordering::Acquire) { break; }
                    *loop_origin.lock().unwrap() = None;
                    loaded.store(false, Ordering::Release);
                    *window.state::<Diagnostic>().0.lock().unwrap() = None;
                    if !first_start {
                        startup_loaded.store(false, Ordering::Release);
                        if let Err(error) = window.navigate(tauri::Url::parse("tauri://localhost/index.html").unwrap()) {
                            diagnostic(&window, &loop_origin, &error.to_string());
                            while !host.retry.swap(false, Ordering::AcqRel) && !host.stop.load(Ordering::Acquire) { std::thread::sleep(Duration::from_millis(100)); }
                            continue;
                        }
                    }
                    first_start = false;
                    // This worker waits for the bundled DOM, leaving the native event
                    // loop free to paint the loading state and handle close requests.
                    let loading_deadline = std::time::Instant::now() + Duration::from_secs(10);
                    while !startup_loaded.load(Ordering::Acquire) && !host.stop.load(Ordering::Acquire) && std::time::Instant::now() < loading_deadline {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    if host.stop.load(Ordering::Acquire) { break; }
                    if !startup_loaded.load(Ordering::Acquire) {
                        diagnostic(&window, &loop_origin, "Η οθόνη εκκίνησης δεν ολοκλήρωσε τη φόρτωση");
                        while !host.retry.swap(false, Ordering::AcqRel) && !host.stop.load(Ordering::Acquire) { std::thread::sleep(Duration::from_millis(100)); }
                        continue;
                    }
                    eprintln!("CrateMind startup phase: backend-start");
                    let mut running = match supervisor::RunningBackend::start(config()) {
                        Ok(value) => value,
                        Err(error) => { diagnostic(&window, &loop_origin, &error); while !host.retry.swap(false, Ordering::AcqRel) && !host.stop.load(Ordering::Acquire) { std::thread::sleep(Duration::from_millis(100)); } continue; }
                    };
                    eprintln!("CrateMind startup phase: backend-ready");
                    let startup = security::install_cookie(&window, &running.origin, &running.init.cookie_name(), &running.init.session_secret).and_then(|_| {
                        eprintln!("CrateMind startup phase: cookie-confirmed");
                        // Runtime ACL additions last until exit; the navigation hook
                        // continues to admit only this launch's authenticated origin.
                        #[cfg(target_os = "macos")]
                        window.app_handle().add_capability(security::window_drag_capability(Some(&running.origin))?).map_err(|error| error.to_string())?;
                        *loop_origin.lock().unwrap() = Some(running.origin.clone());
                        window.navigate(running.origin.clone()).map_err(|e| e.to_string())
                    });
                    if let Err(error) = startup { running.stop(); *loop_origin.lock().unwrap() = None; diagnostic(&window, &loop_origin, &error); while !host.retry.swap(false, Ordering::AcqRel) && !host.stop.load(Ordering::Acquire) { std::thread::sleep(Duration::from_millis(100)); } continue; }
                    let mut actions = native_actions::NativeActions::default();
                    let navigation_deadline = std::time::Instant::now() + Duration::from_secs(30);
                    let mut restart = false;
                    let qa_enabled = std::env::args().any(|arg|arg=="--qa-run") && data.join(".cratemind-qa-fixture").is_file() && std::env::args().any(|arg|arg=="--qa-app-data");
                    let mut qa_started = false;
                    while !host.stop.load(Ordering::Acquire) {
                        if host.retry.swap(false, Ordering::AcqRel) { restart = true; break; }
                        if qa_enabled && !qa_started && loaded.load(Ordering::Acquire) {
                            eprintln!("CrateMind startup phase: native-qa");
                            qa_started = true;
                            let qa_window=window.clone();let qa_data=data.clone();let qa_host=host.clone();
                            std::thread::spawn(move||{
                                if let Err(error)=qa::run(&qa_window,&qa_data){let _=std::fs::write(qa_data.join("native-qa-report.json"),serde_json::json!({"ok":false,"error":error}).to_string());}
                                if !std::env::args().any(|arg|arg=="--qa-stay-open"){qa_host.stop.store(true,Ordering::Release);}
                            });
                        }
                        if !loaded.load(Ordering::Acquire) && std::time::Instant::now() > navigation_deadline { diagnostic(&window, &loop_origin, "Η προβολή δεν ολοκλήρωσε τη φόρτωση"); break; }
                        if running.exited() { diagnostic(&window, &loop_origin, "Η υπηρεσία βιβλιοθήκης σταμάτησε"); break; }
                        match running.events.recv_timeout(Duration::from_millis(100)) {
                            Ok(Ok(BackendEvent::ExchangePrepared { protocol_version: 1, preview_id, digest, decision, expires_at_unix, local_digest })) => { if actions.register(preview_id, native_actions::Prepared { digest, decision, expires_at_unix, local_digest }).is_err() { diagnostic(&window, &loop_origin, "Μη έγκυρη προεπισκόπηση εισαγωγής"); } },
                            Ok(Ok(BackendEvent::NativeRequest { protocol_version: 1, id, action, arguments })) if protocol::valid_id(&id) => {
                                if action == "restart_for_config" {
                                    let result = native_actions::strict_keys(&arguments, &["revision"]).and_then(|_| arguments.get("revision").filter(|v| v.as_u64().is_some_and(|n| n>0) || v.as_str().is_some_and(protocol::valid_id)).map(|_|()).ok_or("Μη έγκυρη έκδοση ρυθμίσεων".into()));
                                    if result.is_ok() { restart = true; break; }
                                }
                                if action == "apply_exchange" {
                                    match actions.take_prepared(&arguments) {
                                        Ok((preview_id, prepared)) => {
                                            let init = running.init.clone();
                                            let _ = window.hide(); running.stop();
                                            if let Err(error) = supervisor::apply_exchange(&init, &preview_id, &prepared.decision, prepared.local_digest.as_deref(), Some(&host.stop)) {
                                                diagnostic(&window, &loop_origin, &error);
                                                // Keep the failure visible until an explicit retry.
                                                // The next backend start recovers the preserved dataset.
                                                while !host.retry.swap(false, Ordering::AcqRel) && !host.stop.load(Ordering::Acquire) { std::thread::sleep(Duration::from_millis(100)); }
                                            }
                                            restart = true; break;
                                        },
                                        Err(error) => { let _ = running.send(&serde_json::json!({"type":"NATIVE_RESULT","protocol_version":1,"id":id,"canceled":false,"error":error})); continue; }
                                    }
                                }
                                let result = native_actions::dialog_action(&action, &arguments);
                                let record = match result { Ok((canceled,value)) => serde_json::json!({"type":"NATIVE_RESULT","protocol_version":1,"id":id,"canceled":canceled,"value":value}), Err(error) => serde_json::json!({"type":"NATIVE_RESULT","protocol_version":1,"id":id,"canceled":false,"error":error}) };
                                let _ = running.send(&record); let _ = window.set_focus();
                            },
                            Ok(_) => { diagnostic(&window, &loop_origin, "Μη έγκυρη επικοινωνία με την υπηρεσία"); break; },
                            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                            Err(_) => {},
                        }
                    }
                    running.stop();
                    let cookie = tauri::webview::Cookie::build((running.init.cookie_name(), "")).domain("127.0.0.1").path("/").build();
                    let _ = window.delete_cookie(cookie);
                    if host.stop.load(Ordering::Acquire) { break; }
                    if !restart && !host.retry.swap(false, Ordering::AcqRel) { while !host.retry.swap(false, Ordering::AcqRel) && !host.stop.load(Ordering::Acquire) { std::thread::sleep(Duration::from_millis(100)); } }
                }
                let _ = midi_thread.join();
                handle.exit(0);
            });
            Ok(())
        });
    let app = builder
        .build(tauri::generate_context!())
        .expect("Αδυναμία αρχικοποίησης CrateMind");
    app.run(move |app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if let Some(host) = app.try_state::<Arc<Host>>() {
                if !host.stop.swap(true, Ordering::AcqRel) {
                    api.prevent_exit();
                }
            }
        }
    });
    drop(allowed);
}
