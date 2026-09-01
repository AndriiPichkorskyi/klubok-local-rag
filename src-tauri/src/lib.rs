mod sidecar;
mod system;
mod metrics;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Міст до Node-сайдкара: запуск/підключення + WebSocket-клієнт.
            sidecar::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar::rpc_call,
            sidecar::sidecar_restart,
            sidecar::sidecar_status,
            system::screen_capture,
            system::launch_app,
            system::frontmost_app,
            system::overlay_show,
            system::overlay_hide,
            system::overlay_highlight,
            metrics::start_metrics,
            metrics::stop_metrics
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
