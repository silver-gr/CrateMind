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
pub fn allow_navigation(candidate: &url::Url, allowed: &AllowedOrigin) -> bool {
    if let Ok(guard) = allowed.lock() {
        if let Some(origin) = guard.as_ref() {
            return same_origin(candidate, origin);
        }
    }
    candidate.as_str() == "tauri://localhost/index.html"
        || candidate.as_str() == "http://tauri.localhost/index.html"
        || candidate.as_str() == "https://tauri.localhost/index.html"
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
