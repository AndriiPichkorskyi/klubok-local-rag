use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use sysinfo::System;
use tauri::{AppHandle, Emitter};
use std::process::Command;
use serde::Serialize;

#[derive(Clone, Serialize)]
struct MetricPayload {
    ram_mb: f64,
    power_score: f64,
    gpu_percent: f64,
}

static IS_MEASURING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn start_metrics(app: AppHandle) {
    if IS_MEASURING.load(Ordering::SeqCst) {
        return;
    }
    IS_MEASURING.store(true, Ordering::SeqCst);
    
    thread::spawn(move || {
        let mut sys = System::new_all();
        
        while IS_MEASURING.load(Ordering::SeqCst) {
            sys.refresh_all();
            
            let mut ollama_pid = 0;
            let mut total_ram = 0.0;
            
            // Збираємо RAM для процесу Ollama (може бути ollama, ollama runner, llama-server)
            for (pid, process) in sys.processes() {
                let name = process.name().to_string_lossy().to_lowercase();
                if name.contains("ollama") || name.contains("llama") || name.contains("ggml") {
                    total_ram += process.memory() as f64 / 1024.0 / 1024.0; // MB
                    if ollama_pid == 0 {
                        ollama_pid = pid.as_u32();
                    }
                }
            }

            let mut power_score = 0.0;
            let mut gpu_percent = 0.0;
            
            // Energy & GPU approximations if we have a PID
            if ollama_pid != 0 {
                // Витягуємо power з top
                let top_out = Command::new("top")
                    .args(["-l", "1", "-pid", &ollama_pid.to_string(), "-stats", "pid,power"])
                    .output();
                    
                if let Ok(out) = top_out {
                    let s = String::from_utf8_lossy(&out.stdout);
                    // top output parsing: find the line with our PID
                    for line in s.lines() {
                        if line.contains(&ollama_pid.to_string()) {
                            let parts: Vec<&str> = line.split_whitespace().collect();
                            if parts.len() >= 2 {
                                if let Ok(power) = parts[1].parse::<f64>() {
                                    power_score = power;
                                }
                            }
                        }
                    }
                }
                
                // GPU без root отримати точно майже неможливо, ми можемо або
                // парсити ioreg або powermetrics (потребує sudo). Для ioreg 
                // це складна дельта accumulatedGPUTime. Для простоти залишимо
                // GPU=0.0 якщо не можемо дістати без пароля.
            }

            let payload = MetricPayload {
                ram_mb: total_ram,
                power_score,
                gpu_percent,
            };

            let _ = app.emit("metrics_tick", payload.clone());
            // Пишемо на диск, щоб Node.js міг читати це під час тестів
            if let Ok(json) = serde_json::to_string(&payload) {
                let _ = std::fs::write("/tmp/ollama_metrics.json", json);
            }

            thread::sleep(Duration::from_secs(1));
        }
    });
}

#[tauri::command]
pub fn stop_metrics() {
    IS_MEASURING.store(false, Ordering::SeqCst);
}
