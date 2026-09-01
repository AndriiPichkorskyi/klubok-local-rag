use sysinfo::{System, ProcessExt, SystemExt};

fn main() {
    let mut sys = System::new_all();
    sys.refresh_all();
    for (pid, process) in sys.processes() {
        let name = process.name().to_lowercase();
        if name.contains("ollama") || name.contains("llama") {
            println!("Found: {} (PID: {}) RAM: {} KB", name, pid, process.memory());
        }
    }
}
