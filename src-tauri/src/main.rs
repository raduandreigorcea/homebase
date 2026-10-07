// Homebase desktop window. The data comes from the local Python service
// (homebase.service on 127.0.0.1:8800); this app is just a native window for it.
use std::{net::TcpStream, process::Command, thread, time::Duration};
use tauri::{WebviewUrl, WebviewWindowBuilder};

const PANEL: &str = "http://127.0.0.1:8800/";

fn main() {
    // GPU rendering has crashed this laptop before, so WebKitGTK draws in software.
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");

    // Make sure the data service is up, then wait (max ~15 s) for it to answer.
    // Done here rather than in a start page: a tauri:// page can't fetch or
    // navigate to plain http, so the old start page waited forever.
    let _ = Command::new("systemctl")
        .args(["--user", "start", "homebase.service"])
        .status();
    for _ in 0..60 {
        if TcpStream::connect("127.0.0.1:8800").is_ok() {
            break;
        }
        thread::sleep(Duration::from_millis(250));
    }

    tauri::Builder::default()
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(PANEL.parse().unwrap()))
                .title("Homebase")
                .inner_size(1280.0, 820.0)
                .min_inner_size(420.0, 500.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Homebase nu a putut porni");
}
