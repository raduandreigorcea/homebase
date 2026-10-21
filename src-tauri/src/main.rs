// Homebase desktop window. The data comes from the local Python service
// (homebase.service on 127.0.0.1:8800, which this app registers itself); this app is just a native window for it.
use std::{fs, net::TcpStream, path::Path, process::Command, thread, time::Duration};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const PANEL: &str = "http://127.0.0.1:8800/";
// First line of the service file this app writes. A file without it is the user's own and is never touched.
const MARK: &str = "# managed by the Homebase app";

fn panel_up() -> bool {
    TcpStream::connect("127.0.0.1:8800").is_ok()
}

fn systemctl(args: &[&str]) -> bool {
    Command::new("systemctl").arg("--user").args(args).status().map(|s| s.success()).unwrap_or(false)
}

/// Make sure the background service (the Python server that watches the network) is running, and starts
/// with the session from now on. It lives in the package next to this app, so the app registers it itself:
/// nothing to set up by hand. After an update (the service file names another version) it is rewritten and
/// restarted. A service file someone wrote themselves is left alone.
fn ensure_service(server: &Path) {
    let home = std::env::var("HOME").unwrap_or_default();
    let config = std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| format!("{home}/.config"));
    let unit = Path::new(&config).join("systemd/user/homebase.service");
    let existing = fs::read_to_string(&unit).ok();

    if server.exists() && existing.as_deref().map_or(true, |t| t.starts_with(MARK)) {
        let want = format!(
            "{MARK} (version {})\n[Unit]\nDescription=Homebase control panel (http://127.0.0.1:8800)\n\n\
             [Service]\nExecStart=/usr/bin/python3 \"{}\"\nRestart=on-failure\nNice=10\n\n\
             [Install]\nWantedBy=default.target\n",
            env!("CARGO_PKG_VERSION"),
            server.display()
        );
        if existing.as_deref() != Some(want.as_str()) {
            if let Some(dir) = unit.parent() {
                let _ = fs::create_dir_all(dir);
            }
            if fs::write(&unit, want).is_ok() {
                systemctl(&["daemon-reload"]);
                systemctl(&["enable", "homebase.service"]);
                systemctl(&["restart", "homebase.service"]);
            }
        }
    }
    if !panel_up() && !systemctl(&["start", "homebase.service"]) {
        // No systemd for this user (a minimal setup): run the service directly, for this session.
        let _ = Command::new("python3").arg(server).spawn();
    }
}

fn main() {
    // The window uses the GPU. If that ever causes trouble (it froze this laptop once, with a browser),
    // start it with HOMEBASE_SOFTWARE=1 to draw in software instead.
    if std::env::var("HOMEBASE_SOFTWARE").as_deref() == Ok("1") {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }

    tauri::Builder::default()
        .setup(|app| {
            // Make sure the data service is up, then wait (max ~15 s) for it to answer.
            // Done here rather than in a start page: a tauri:// page can't fetch or
            // navigate to plain http, so the old start page waited forever.
            let server = app.path().resource_dir()?.join("server/server.py");
            ensure_service(&server);
            for _ in 0..60 {
                if panel_up() {
                    break;
                }
                thread::sleep(Duration::from_millis(250));
            }
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(PANEL.parse().unwrap()))
                .title("Homebase")
                .inner_size(1280.0, 820.0)
                .min_inner_size(420.0, 500.0)
                // Fullscreen from the start: this window is the panel, nothing else. F11 in the panel leaves and
                // re-enters it (through the "panel" capability); HOMEBASE_WINDOWED=1 starts in a normal window.
                .fullscreen(std::env::var("HOMEBASE_WINDOWED").as_deref() != Ok("1"))
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Homebase failed to start");
}
