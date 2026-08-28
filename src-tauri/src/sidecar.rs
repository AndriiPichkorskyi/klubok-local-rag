// Міст Tauri ↔ Node-sidecar.
// Відповідальність: запуск (або підключення до) процесу sidecar, WebSocket-клієнт
// за контрактом docs/contracts/rpc.md, перевипуск прогресу як подій Tauri
// та мовчазне автоперепідключення. Уся предметна логіка живе в Node.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

/// Типовий ліміт очікування відповіді. Перекривається config.rpc.requestTimeoutSec,
/// бо повна векторизація триває значно довше за будь-який «розумний» дефолт.
const DEFAULT_REQUEST_TIMEOUT_SEC: u64 = 3600;
/// Пауза між спробами перепідключення.
const RECONNECT_DELAY: Duration = Duration::from_millis(500);

struct RpcConfig {
    host: String,
    port: u16,
    token: String,
    request_timeout: Duration,
}

pub struct Sidecar {
    root: PathBuf,
    cfg: RpcConfig,
    /// true = процесом Node керує розробник у своєму терміналі (SIDECAR_EXTERNAL=1).
    external: bool,
    next_id: AtomicU64,
    connected: AtomicBool,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    /// id запиту -> мітка, яку передав фронтенд. Дозволяє відрізнити прогрес
    /// панелі розробника від прогресу пошуку, коли обидва працюють одночасно.
    refs: Mutex<HashMap<u64, String>>,
    out: Mutex<Option<mpsc::UnboundedSender<String>>>,
    child: Mutex<Option<Child>>,
}

impl Sidecar {
    fn status_value(&self) -> Value {
        json!({
            "connected": self.connected.load(Ordering::SeqCst),
            "mode": if self.external { "external" } else { "managed" },
            "host": self.cfg.host,
            "port": self.cfg.port,
            "pid": self.child.lock().unwrap().as_ref().map(|c| c.id()),
        })
    }

    /// Обірвати всі запити, що чекали на відповідь у втраченому з'єднанні.
    fn fail_pending(&self) {
        self.refs.lock().unwrap().clear();
        let drained: Vec<_> = self.pending.lock().unwrap().drain().collect();
        for (id, tx) in drained {
            let _ = tx.send(json!({"id": id, "error": {"message": "з'єднання із sidecar розірвано"}}));
        }
    }
}

/// Шукаємо корінь проєкта (там, де лежить config/pipeline.config.json), піднімаючись від cwd.
fn find_root() -> PathBuf {
    let mut dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    loop {
        if dir.join("config/pipeline.config.json").is_file() {
            return dir;
        }
        if !dir.pop() {
            break;
        }
    }
    // Запасний варіант: src-tauri/.. — так працює і збірка з іншої робочої теки.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Порт і токен беремо лише з конфіга — нічого не хардкодимо, крім аварійних значень.
fn read_config(root: &Path) -> RpcConfig {
    let path = root.join("config/pipeline.config.json");
    let parsed: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| {
            eprintln!("[sidecar] не вдалося прочитати {}, беремо типові значення", path.display());
            Value::Null
        });
    let rpc = &parsed["rpc"];
    RpcConfig {
        host: rpc["host"].as_str().unwrap_or("127.0.0.1").to_string(),
        port: rpc["port"].as_u64().unwrap_or(17817) as u16,
        token: rpc["token"].as_str().unwrap_or_default().to_string(),
        request_timeout: Duration::from_secs(
            rpc["requestTimeoutSec"].as_u64().unwrap_or(DEFAULT_REQUEST_TIMEOUT_SEC),
        ),
    }
}

fn spawn_child(root: &Path) -> Option<Child> {
    match Command::new("node")
        .arg("sidecar/src/rpc/server.js")
        .current_dir(root)
        .spawn()
    {
        Ok(c) => {
            println!("[sidecar] запущено node sidecar/src/rpc/server.js, pid={}", c.id());
            Some(c)
        }
        Err(e) => {
            eprintln!("[sidecar] не вдалося запустити node: {e}");
            None
        }
    }
}

/// Розбір одного вхідного фрейму: прогрес — у подію, решта — власнику id.
fn handle_frame(app: &AppHandle, state: &Sidecar, text: &str) {
    let value: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[sidecar] нерозбірливий фрейм: {e}");
            return;
        }
    };
    if value.get("type").and_then(Value::as_str) == Some("progress") {
        let mut event = value;
        // Додаємо мітку власника, щоб фронтенд не вгадував, чий це прогрес.
        if let Some(id) = event.get("id").and_then(Value::as_u64) {
            if let Some(client_ref) = state.refs.lock().unwrap().get(&id) {
                event["ref"] = json!(client_ref);
            }
        }
        let _ = app.emit("sidecar://progress", event);
        return;
    }
    if let Some(id) = value.get("id").and_then(Value::as_u64) {
        state.refs.lock().unwrap().remove(&id);
        if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(value);
        }
    } else if value.get("error").is_some() {
        // Помилка рівня протоколу приходить з id: null і нікому не належить.
        eprintln!("[sidecar] помилка протоколу: {}", value["error"]);
    }
}

/// Обслуговування одного встановленого з'єднання: авторизація + перекачування фреймів.
async fn pump(app: &AppHandle, state: &Arc<Sidecar>) -> Result<(), String> {
    let url = format!("ws://{}:{}", state.cfg.host, state.cfg.port);
    let (ws, _) = tokio_tungstenite::connect_async(url.as_str())
        .await
        .map_err(|e| e.to_string())?;
    let (mut sink, mut stream) = ws.split();

    // Контракт: перший фрейм від клієнта — auth, інакше сервер закриє з'єднання.
    let auth = json!({"type": "auth", "token": state.cfg.token}).to_string();
    sink.send(Message::text(auth)).await.map_err(|e| e.to_string())?;

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    {
        *state.out.lock().unwrap() = Some(tx);
    }
    state.connected.store(true, Ordering::SeqCst);
    println!("[sidecar] підключено до {url}");
    let _ = app.emit("sidecar://status", state.status_value());

    loop {
        tokio::select! {
            outgoing = rx.recv() => match outgoing {
                Some(text) => {
                    if sink.send(Message::text(text)).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(text))) => handle_frame(app, state, text.as_str()),
                Some(Ok(Message::Ping(payload))) => {
                    let _ = sink.send(Message::Pong(payload)).await;
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    eprintln!("[sidecar] помилка сокета: {e}");
                    break;
                }
                None => break,
            },
        }
    }
    Ok(())
}

/// Вічний цикл: тримає з'єднання живим. Він же — очікування, доки порт підніметься,
/// і він же — тихе перепідключення після рестарту sidecar по --watch.
async fn connection_loop(app: AppHandle, state: Arc<Sidecar>) {
    let mut silent = false;
    loop {
        match pump(&app, &state).await {
            Ok(()) => {
                println!("[sidecar] з'єднання втрачено, перепідключаємось…");
                silent = false;
            }
            Err(e) => {
                if !silent {
                    println!("[sidecar] чекаємо на sidecar ({e})");
                    silent = true; // далі мовчимо, щоб не засмічувати лог
                }
            }
        }
        {
            *state.out.lock().unwrap() = None;
        }
        state.connected.store(false, Ordering::SeqCst);
        state.fail_pending();
        let _ = app.emit("sidecar://status", state.status_value());
        tokio::time::sleep(RECONNECT_DELAY).await;
    }
}

/// Універсальний виклик методу sidecar. Генерує id і чекає на відповідь саме з ним.
/// `client_ref` — необов'язкова мітка від фронтенду; повертається в подіях прогресу,
/// щоб кілька паралельних операцій не плутали свої повідомлення.
#[tauri::command]
pub async fn rpc_call(
    state: State<'_, Arc<Sidecar>>,
    method: String,
    params: Option<Value>,
    client_ref: Option<String>,
) -> Result<Value, String> {
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let sender = { state.out.lock().unwrap().clone() }
        .ok_or_else(|| "sidecar не підключений".to_string())?;

    let (tx, rx) = oneshot::channel();
    {
        state.pending.lock().unwrap().insert(id, tx);
    }
    if let Some(r) = client_ref {
        state.refs.lock().unwrap().insert(id, r);
    }
    let payload = json!({"id": id, "method": method, "params": params.unwrap_or_else(|| json!({}))});
    if sender.send(payload.to_string()).is_err() {
        state.pending.lock().unwrap().remove(&id);
        state.refs.lock().unwrap().remove(&id);
        return Err("канал до sidecar закрито".into());
    }

    match tokio::time::timeout(state.cfg.request_timeout, rx).await {
        Ok(Ok(value)) => match value.get("error") {
            Some(err) => Err(err
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| err.to_string())),
            None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
        },
        Ok(Err(_)) => Err("відповідь не надійшла: з'єднання розірвано".into()),
        Err(_) => {
            state.pending.lock().unwrap().remove(&id);
            state.refs.lock().unwrap().remove(&id);
            Err(format!("час очікування відповіді на «{method}» вичерпано"))
        }
    }
}

/// Перезапуск дочірнього процесу. Перепідключення відбудеться саме, циклом вище.
#[tauri::command]
pub fn sidecar_restart(state: State<'_, Arc<Sidecar>>) -> Result<Value, String> {
    if state.external {
        return Err("режим SIDECAR_EXTERNAL: процесом керує розробник у своєму терміналі".into());
    }
    let mut slot = state.child.lock().unwrap();
    if let Some(mut old) = slot.take() {
        let _ = old.kill();
        let _ = old.wait();
    }
    *slot = spawn_child(&state.root);
    match slot.as_ref() {
        Some(c) => Ok(json!({"restarted": true, "pid": c.id()})),
        None => Err("не вдалося запустити node".into()),
    }
}

#[tauri::command]
pub fn sidecar_status(state: State<'_, Arc<Sidecar>>) -> Value {
    state.status_value()
}

/// Викликається з setup() застосунку.
pub fn init(app: &AppHandle) {
    let root = find_root();
    let cfg = read_config(&root);
    let external = std::env::var("SIDECAR_EXTERNAL").is_ok_and(|v| v == "1");

    let child = if external {
        println!("[sidecar] режим external: підключаємось до вже запущеного сервера");
        None
    } else {
        spawn_child(&root)
    };

    let state = Arc::new(Sidecar {
        root,
        cfg,
        external,
        next_id: AtomicU64::new(1),
        refs: Mutex::new(HashMap::new()),
        connected: AtomicBool::new(false),
        pending: Mutex::new(HashMap::new()),
        out: Mutex::new(None),
        child: Mutex::new(child),
    });

    app.manage(state.clone());
    tauri::async_runtime::spawn(connection_loop(app.clone(), state));
}
