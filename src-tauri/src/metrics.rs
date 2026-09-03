use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::System;
use tauri::{AppHandle, Emitter};

const METRICS_FILE_NAME: &str = "ollama_metrics.json";
const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Serialize)]
struct MetricPayload {
    ram_mb: f64,
    // `None` серіалізується як null: відсутнє вимірювання не можна видавати за нуль.
    power_score: Option<f64>,
    gpu_percent: Option<f64>,
    gpu_memory_mb: Option<f64>,
    sampled_at_ms: u64,
}

#[derive(Debug, PartialEq)]
struct GpuMetrics {
    percent: f64,
    memory_mb: Option<f64>,
}

static IS_MEASURING: AtomicBool = AtomicBool::new(false);

fn is_ollama_process(name: &str) -> bool {
    let normalized = name.to_lowercase();
    normalized.contains("ollama")
        || normalized.contains("llama-server")
        || normalized.contains("ggml")
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn metrics_path() -> PathBuf {
    std::env::temp_dir().join(METRICS_FILE_NAME)
}

fn parse_number_after(text: &str, marker: &str) -> Option<f64> {
    let tail = text.split_once(marker)?.1.trim_start();
    let value = tail
        .trim_start_matches('=')
        .trim_start()
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || *ch == '.' || *ch == '-')
        .collect::<String>();
    if value.is_empty() {
        None
    } else {
        value.parse::<f64>().ok()
    }
}

/// Читає системне навантаження GPU Apple Silicon без root-доступу.
/// Це метрика всього GPU, тому для чистого експерименту стороннє GPU-навантаження
/// має бути прибране. На інших ОС повертаємо None, а не фальшивий 0%.
fn parse_ioreg_gpu_metrics(output: &str) -> Option<GpuMetrics> {
    output
        .lines()
        .filter(|line| line.contains("\"PerformanceStatistics\""))
        .filter_map(|line| {
            let percent = parse_number_after(line, "\"Device Utilization %\"")?;
            let memory_mb = parse_number_after(line, "\"In use system memory\"")
                .map(|bytes| bytes / 1024.0 / 1024.0);
            Some(GpuMetrics {
                percent: percent.clamp(0.0, 100.0),
                memory_mb,
            })
        })
        // Якщо прискорювачів кілька, беремо активний; пам'ять належить тому
        // самому запису, тому не змішуємо її з іншою відеокартою.
        .max_by(|left, right| left.percent.total_cmp(&right.percent))
}

#[cfg(target_os = "macos")]
fn read_gpu_metrics() -> Option<GpuMetrics> {
    let output = Command::new("/usr/sbin/ioreg")
        .args(["-l", "-w", "0", "-r", "-c", "IOAccelerator"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_ioreg_gpu_metrics(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(target_os = "macos"))]
fn read_gpu_metrics() -> Option<GpuMetrics> {
    None
}

#[cfg(target_os = "macos")]
fn read_power_score(pids: &HashSet<u32>) -> Option<f64> {
    if pids.is_empty() {
        return None;
    }

    let mut command = Command::new("top");
    command.args(["-l", "1", "-stats", "pid,power"]);
    for pid in pids {
        command.args(["-pid", &pid.to_string()]);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }

    let values = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse::<u32>().ok()?;
            if !pids.contains(&pid) {
                return None;
            }
            parts.next()?.parse::<f64>().ok()
        })
        .collect::<Vec<_>>();

    (!values.is_empty()).then(|| values.into_iter().sum())
}

#[cfg(not(target_os = "macos"))]
fn read_power_score(_pids: &HashSet<u32>) -> Option<f64> {
    None
}

/// Запис через тимчасовий файл не дозволяє Node прочитати половину JSON.
fn write_metrics_snapshot(payload: &MetricPayload) {
    let Ok(json) = serde_json::to_vec(payload) else {
        return;
    };
    let path = metrics_path();
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    if std::fs::write(&temporary, json).is_ok() {
        let _ = std::fs::rename(temporary, &path);
    }
}

#[tauri::command]
pub fn start_metrics(app: AppHandle) {
    if IS_MEASURING.swap(true, Ordering::SeqCst) {
        return;
    }

    thread::spawn(move || {
        let mut system = System::new_all();

        while IS_MEASURING.load(Ordering::SeqCst) {
            system.refresh_all();

            let mut ollama_pids = HashSet::new();
            let mut total_ram = 0.0;
            for (pid, process) in system.processes() {
                let name = process.name().to_string_lossy();
                if is_ollama_process(&name) {
                    total_ram += process.memory() as f64 / 1024.0 / 1024.0;
                    ollama_pids.insert(pid.as_u32());
                }
            }

            // `top` може чекати системний зріз, тому GPU читаємо після нього:
            // sampled_at_ms тоді описує свіжий GPU-показник, а не старий.
            let power_score = read_power_score(&ollama_pids);
            let gpu = read_gpu_metrics();
            let payload = MetricPayload {
                ram_mb: total_ram,
                power_score,
                gpu_percent: gpu.as_ref().map(|value| value.percent),
                gpu_memory_mb: gpu.and_then(|value| value.memory_mb),
                sampled_at_ms: unix_time_ms(),
            };

            let _ = app.emit("metrics_tick", payload.clone());
            write_metrics_snapshot(&payload);
            thread::sleep(SAMPLE_INTERVAL);
        }
    });
}

#[tauri::command]
pub fn stop_metrics() {
    IS_MEASURING.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_apple_gpu_statistics() {
        let output = r#"| "PerformanceStatistics" = {"Alloc system memory"=9417801728,"Renderer Utilization %"=23,"Device Utilization %"=24,"In use system memory"=7252393984}"#;
        let parsed = parse_ioreg_gpu_metrics(output).expect("метрики мають розібратися");

        assert_eq!(parsed.percent, 24.0);
        assert!((parsed.memory_mb.expect("пам'ять має бути") - 6916.421875).abs() < 0.001);
    }

    #[test]
    fn absent_gpu_statistics_are_not_zero() {
        assert_eq!(parse_ioreg_gpu_metrics("GPU statistics unavailable"), None);
    }
}
