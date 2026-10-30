use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::webview::{cookie::SameSite, Cookie};
pub type AllowedOrigin = Arc<Mutex<Option<url::Url>>>;
pub fn same_origin(candidate: &url::Url, origin: &url::Url) -> bool {
    candidate.scheme() == "http"
        && candidate.username().is_empty()
        && candidate.password().is_none()
        && candidate.host_str() == Some("127.0.0.1")
        && candidate.port_or_known_default() == origin.port_or_known_default()
}
pub fn is_startup_document(candidate: &url::Url) -> bool {
    // Tauri 2 resolves App("index.html") to the app root, while retries use
    // /index.html explicitly. Keep both forms within the same bundled origin.
    let local_origin = match candidate.scheme() {
        "tauri" => candidate.host_str() == Some("localhost"),
        "http" | "https" => candidate.host_str() == Some("tauri.localhost"),
        _ => false,
    };
    local_origin
        && candidate.username().is_empty()
        && candidate.password().is_none()
        && candidate.port().is_none()
        && matches!(candidate.path(), "" | "/" | "/index.html")
        && candidate.query().is_none()
        && candidate.fragment().is_none()
}
pub fn allow_navigation(candidate: &url::Url, allowed: &AllowedOrigin) -> bool {
    if let Ok(guard) = allowed.lock() {
        if let Some(origin) = guard.as_ref() {
            return same_origin(candidate, origin);
        }
    }
    is_startup_document(candidate)
}
pub fn window_drag_capability(
    backend_origin: Option<&url::Url>,
) -> Result<tauri::ipc::CapabilityBuilder, String> {
    // Only the built-in drag gesture is exposed. The backend's authenticated,
    // launch-specific origin is registered immediately before navigating to it.
    let (identifier, remote) = match backend_origin {
        Some(origin)
            if same_origin(origin, origin)
                && origin.port().is_some_and(|port| port > 0)
                && origin.path() == "/"
                && origin.query().is_none()
                && origin.fragment().is_none() =>
        {
            (
                format!("main-drag-backend-{}", origin.port().unwrap()),
                Some(format!("{}/*", origin.origin().ascii_serialization())),
            )
        }
        Some(_) => return Err("Μη έγκυρη διεύθυνση για μετακίνηση παραθύρου".into()),
        None => ("main-drag-local".into(), None),
    };
    let capability = tauri::ipc::CapabilityBuilder::new(identifier)
        // The local capability also covers the borderless startup splash.
        .windows(if remote.is_none() { vec!["main", "splash"] } else { vec!["main"] })
        .local(remote.is_none())
        .permission("core:window:allow-start-dragging");
    Ok(match remote {
        Some(pattern) => capability.remote(pattern),
        None => capability,
    })
}
// Run only on a background thread: WebView2 cookie readback can dispatch to the UI thread.
pub fn install_cookie(
    window: &tauri::WebviewWindow,
    _origin: &url::Url,
    name: &str,
    secret: &str,
) -> Result<(), String> {
    let cookie = Cookie::build((name.to_string(), secret.to_string()))
        .domain("127.0.0.1")
        .path("/")
        .http_only(true)
        .same_site(SameSite::Strict)
        // Leave Secure absent for plain loopback HTTP. wry's macOS bridge
        // inserts NSHTTPCookieSecure="FALSE" for Some(false), but Foundation
        // treats presence of that property as secure=true.
        .build();
    window
        .set_cookie(cookie)
        .map_err(|_| "Αποτυχία εγκατάστασης ελέγχου πρόσβασης")?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if window
            // wry 0.57's macOS cookies_for_url compares against Url::domain(),
            // which is None for IPv4 hosts. Read natively and filter explicitly.
            .cookies()
            .map_err(|_| "Αποτυχία ελέγχου πρόσβασης")?
            .iter()
            .any(|c| {
                c.name() == name
                    && c.value() == secret
                    && c.domain() == Some("127.0.0.1")
                    && c.path() == Some("/")
                    && c.http_only() == Some(true)
                    && c.secure() != Some(true)
                    && c.same_site() == Some(SameSite::Strict)
            })
        {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("Δεν επιβεβαιώθηκε ο έλεγχος πρόσβασης".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::RuntimeCapability;

    #[test]
    fn window_drag_is_limited_to_app_windows_and_one_permission() {
        let origin = url::Url::parse("http://127.0.0.1:1234/").unwrap();
        for backend in [None, Some(&origin)] {
            let tauri::utils::acl::capability::CapabilityFile::Capability(capability) =
                window_drag_capability(backend).unwrap().build()
            else {
                panic!("expected a single window drag capability")
            };
            if backend.is_none() {
                assert_eq!(capability.windows, ["main", "splash"]);
            } else {
                assert_eq!(capability.windows, ["main"]);
            }
            assert!(capability.webviews.is_empty());
            assert_eq!(capability.local, backend.is_none());
            assert_eq!(
                serde_json::to_value(&capability.permissions).unwrap(),
                serde_json::json!(["core:window:allow-start-dragging"])
            );
            if backend.is_some() {
                let patterns = capability.remote.unwrap().urls;
                assert_eq!(patterns, ["http://127.0.0.1:1234/*"]);
                let pattern: tauri::utils::acl::RemoteUrlPattern = patterns[0].parse().unwrap();
                for route in ["/", "/library", "/sets?selected=1"] {
                    assert!(pattern.test(&origin.join(route).unwrap()));
                }
                for value in [
                    "http://127.0.0.1:1235/library",
                    "https://127.0.0.1:1234/",
                    "http://localhost:1234/",
                    "http://127.0.0.1.evil:1234/",
                    "https://example.com/",
                ] {
                    assert!(!pattern.test(&url::Url::parse(value).unwrap()), "{value}");
                }
            } else {
                assert!(capability.remote.is_none());
            }
        }
    }

    #[test]
    fn window_drag_rejects_untrusted_or_non_origin_urls() {
        for value in [
            "https://127.0.0.1:1234/",
            "http://localhost:1234/",
            "http://127.0.0.1.evil:1234/",
            "http://user@127.0.0.1:1234/",
            "http://127.0.0.1:0/",
            "http://127.0.0.1/",
            "http://127.0.0.1:1234/route",
            "http://127.0.0.1:1234/?query",
            "http://127.0.0.1:1234/#fragment",
            "tauri://localhost/",
        ] {
            assert!(
                window_drag_capability(Some(&url::Url::parse(value).unwrap())).is_err(),
                "{value}"
            );
        }
    }
    #[test]
    fn bundled_startup_accepts_normalized_root_and_explicit_document() {
        let allowed = Arc::new(Mutex::new(None));
        for value in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/",
            "https://tauri.localhost/index.html",
        ] {
            let url = url::Url::parse(value).unwrap();
            assert!(is_startup_document(&url), "{value}");
            assert!(allow_navigation(&url, &allowed), "{value}");
        }
    }
    #[test]
    fn bundled_startup_rejects_other_origins_and_documents() {
        for value in [
            "tauri://localhost.evil/",
            "tauri://user@localhost/",
            "tauri://localhost:1234/",
            "tauri://localhost/other.html",
            "tauri://localhost/?retry=1",
            "tauri://localhost/#retry",
            "http://localhost/",
            "http://tauri.localhost.evil/",
            "https://user:secret@tauri.localhost/index.html",
            "https://tauri.localhost:1234/",
            "file:///index.html",
            "about:blank",
        ] {
            assert!(
                !is_startup_document(&url::Url::parse(value).unwrap()),
                "{value}"
            );
        }
        let allowed = Arc::new(Mutex::new(Some(
            url::Url::parse("http://127.0.0.1:1234/").unwrap(),
        )));
        assert!(!allow_navigation(
            &url::Url::parse("tauri://localhost/").unwrap(),
            &allowed
        ));
    }
    #[test]
    fn exact_origin_rejects_confusable_urls() {
        let origin = url::Url::parse("http://127.0.0.1:1234/").unwrap();
        assert!(same_origin(&origin.join("api/audio/1").unwrap(), &origin));
        for value in [
            "http://127.0.0.1:1235/",
            "http://127.0.0.1.evil:1234/",
            "http://user@127.0.0.1:1234/",
            "https://127.0.0.1:1234/",
            "file:///tmp/x",
            "javascript:alert(1)",
        ] {
            assert!(
                !same_origin(&url::Url::parse(value).unwrap(), &origin),
                "{value}"
            );
        }
    }
}
