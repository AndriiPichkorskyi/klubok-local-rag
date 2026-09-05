mod sidecar;
mod system;
mod metrics;

use tauri::{Manager, WindowEvent};

/// Вікна модуля walkthrough. `overlay_hide` їх ХОВАЄ, а не закриває (щоб не
/// створювати заново на кожному кроці), тому після сесії ведення вони лишаються
/// існувати. Для Tauri це означає «застосунок ще має вікна», і закриття
/// головного вікна не завершувало процес: у Dock лишалась активна іконка, і
/// вийти можна було тільки через контекстне меню.
const WALKTHROUGH_LABELS: [&str; 2] = ["walkthrough-hint", "walkthrough-highlight"];

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            // Закрили головне вікно — завершуємо застосунок разом із схованими
            // вікнами підказки. Далі спрацює RunEvent::Exit, який прибирає node.
            if matches!(event, WindowEvent::CloseRequested { .. })
                && !WALKTHROUGH_LABELS.contains(&window.label())
            {
                window.app_handle().exit(0);
            }
        })
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Вихід застосунку мусить забирати з собою дочірній sidecar, інакше
        // процес лишається сиротою і тримає порт до наступного разу.
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                sidecar::shutdown(app);
            }
        });
}
