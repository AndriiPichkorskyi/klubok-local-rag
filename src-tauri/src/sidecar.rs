// Міст Tauri ↔ Node-sidecar.
// Відповідальність: запуск (або підключення до) процесу sidecar, WebSocket-клієнт
// за контрактом docs/contracts/rpc.md, перевипуск прогресу як подій Tauri
// та мовчазне автоперепідключення. Уся предметна логіка живе в Node.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
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
/// Пауза перед спробою підняти мертвий процес sidecar; далі подвоюється.
const RESPAWN_BACKOFF: Duration = Duration::from_millis(500);
/// Стеля цієї паузи: node може падати з постійної причини, і спам новими
/// процесами щопівсекунди шкідливіший за пізнішу спробу.
const MAX_RESPAWN_BACKOFF: Duration = Duration::from_secs(10);

struct RpcConfig {
    host: String,
    port: u16,
    token: String,
    request_timeout: Duration,
}

pub struct Sidecar {
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

/// Де лежить код і де лежать записувані дані.
///
/// Два режими життя застосунку різняться саме цим. `npm run app`: усе в теці
/// проєкта, і поведінка мусить лишатись такою, як була. Зібраний .app: код у
/// `Contents/Resources` (тільки для читання), тому база, журнали і конфіг
/// живуть у `~/Library/Application Support/<identifier>`.
///
/// Резолвиться РІВНО ОДИН раз: `system.rs` і перезапуск процесу мусять бачити
/// ту саму теку даних, що й Node, інакше знімок екрана запише один, а шукатиме
/// його інший.
pub(crate) struct Layout {
    /// cwd для node і корінь відносних шляхів коду (тут лежать `config/` і `sidecar/`)
    pub root: PathBuf,
    /// тека записуваних даних (для Node — `SIDECAR_DATA_DIR`)
    pub data: PathBuf,
    /// конфіг, який читають і Rust, і Node
    pub config: PathBuf,
    /// бінарник node
    pub node: PathBuf,
    /// true = зібраний застосунок
    pub bundled: bool,
}

static LAYOUT: OnceLock<Layout> = OnceLock::new();

/// Розкладка застосунку. Резолвиться при `init()`; решта коду лише читає.
pub(crate) fn layout() -> &'static Layout {
    LAYOUT.get_or_init(|| resolve_layout(None))
}

/// Тека проєкта в режимі розробки: піднімаємось від cwd, доки не знайдемо конфіг.
/// Не знайшли — значить це зібраний застосунок, і вгадувати шлях не треба:
/// раніше тут був `CARGO_MANIFEST_DIR`, тобто шлях машини, на якій компілювали.
fn find_dev_root() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    loop {
        if dir.join("config/pipeline.config.json").is_file() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// Бінарник node. У бандлі його кладе `externalBin` поруч із виконуваним файлом
/// (`Contents/MacOS/node`), тож застосунок не залежить від PATH, у якому в
/// GUI-процесі немає ні homebrew, ні nvm. Останній варіант — системний node:
/// саме так працює звичайний `npm run app`.
fn resolve_node(app: Option<&AppHandle>) -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(candidate) = exe.parent().map(|dir| dir.join("node")) {
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    if let Some(candidate) = app
        .and_then(|handle| handle.path().resource_dir().ok())
        .map(|dir| dir.join("node"))
    {
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from("node")
}

fn resolve_layout(app: Option<&AppHandle>) -> Layout {
    let node = resolve_node(app);

    // Режим розробки: жодних змінних оточення для Node — поведінка та сама,
    // що й до пакування (дані лежать у sidecar/, конфіг читається з проєкта).
    if let Some(root) = find_dev_root() {
        return Layout {
            data: root.join("sidecar"),
            config: root.join("config/pipeline.config.json"),
            node,
            root,
            bundled: false,
        };
    }

    let root = app
        .and_then(|handle| handle.path().resource_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let data = app
        .and_then(|handle| handle.path().app_data_dir().ok())
        .unwrap_or_else(|| root.clone());
    let config = data.join("config/pipeline.config.json");

    // Конфіг мусить бути записуваним: його змінює `config.get`/`updateModels`
    // і людина руками. Тому при першому запуску кладемо копію з ресурсів.
    if let Err(e) = std::fs::create_dir_all(data.join("config")) {
        eprintln!("[sidecar] не вдалося створити теку даних {}: {e}", data.display());
    }
    if !config.is_file() {
        let source = root.join("config/pipeline.config.json");
        match std::fs::copy(&source, &config) {
            Ok(_) => println!("[sidecar] конфіг скопійовано у {}", config.display()),
            Err(e) => eprintln!("[sidecar] не вдалося скопіювати конфіг з {}: {e}", source.display()),
        }
    }

    ensure_unique_token(&config);

    Layout { root, data, config, node, bundled: true }
}

/// Випадковий шістнадцятковий рядок із /dev/urandom. Без зовнішніх крейтів:
/// генератор потрібен рівно один раз за життя встановленої копії.
fn random_hex(bytes: usize) -> Option<String> {
    let mut file = std::fs::File::open("/dev/urandom").ok()?;
    let mut buf = vec![0u8; bytes];
    std::io::Read::read_exact(&mut file, &mut buf).ok()?;
    Some(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Замінює токен-заглушку в записуваній копії конфіга на випадковий.
///
/// Токен із репозиторію однаковий у всіх встановлених копій, тобто фактично
/// публічний. Разом із перевіркою `Origin` на боці sidecar це закриває доступ
/// до RPC ззовні. Заміна текстова, а не через serde_json, щоб не переставляти
/// ключі конфіга місцями: його читають і правлять руками.
fn ensure_unique_token(path: &Path) {
    const PLACEHOLDER: &str = "dev-local-token-change-me";

    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    if !text.contains(PLACEHOLDER) {
        return; // токен уже свій
    }
    let Some(token) = random_hex(24) else {
        eprintln!("[sidecar] не вдалося прочитати /dev/urandom — токен лишається типовим");
        return;
    };
    match std::fs::write(path, text.replace(PLACEHOLDER, &token)) {
        Ok(()) => println!("[sidecar] згенеровано власний токен RPC для цієї копії"),
        Err(e) => eprintln!("[sidecar] не вдалося записати токен у {}: {e}", path.display()),
    }
}

/// Порт і токен беремо лише з конфіга — нічого не хардкодимо, крім аварійних значень.
fn read_config(path: &Path) -> RpcConfig {
    let parsed: Value = std::fs::read_to_string(path)
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

fn spawn_child(layout: &Layout) -> Option<Child> {
    let mut command = Command::new(&layout.node);
    command.arg("sidecar/src/rpc/server.js").current_dir(&layout.root);

    // Змінні задаємо ЛИШЕ в бандлі: у режимі розробки їх відсутність і є
    // «як було» — sidecar сам рахує теку даних від свого розташування.
    if layout.bundled {
        command
            .env("SIDECAR_DATA_DIR", &layout.data)
            .env("SIDECAR_LOG_DIR", layout.data.join("logs"))
            .env("PIPELINE_CONFIG", &layout.config);
    }

    match command.spawn() {
        Ok(c) => {
            println!(
                "[sidecar] запущено {} sidecar/src/rpc/server.js у {} (дані: {}), pid={}",
                layout.node.display(),
                layout.root.display(),
                layout.data.display(),
                c.id()
            );
            Some(c)
        }
        Err(e) => {
            eprintln!("[sidecar] не вдалося запустити {}: {e}", layout.node.display());
            None
        }
    }
}

/// Чи завершився дочірній процес. `try_wait` не блокує і водночас прибирає зомбі.
/// `None` у слоті означає, що процес не вдалося запустити взагалі.
fn child_exited(state: &Sidecar) -> bool {
    let mut slot = state.child.lock().unwrap();
    match slot.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(Some(status)) => {
                eprintln!("[sidecar] процес node завершився: {status}");
                *slot = None;
                true
            }
            Ok(None) => false,
            Err(e) => {
                eprintln!("[sidecar] не вдалося перевірити стан node: {e}");
                false
            }
        },
        None => true,
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
    let mut respawns: u32 = 0;
    loop {
        match pump(&app, &state).await {
            Ok(()) => {
                println!("[sidecar] з'єднання втрачено, перепідключаємось…");
                silent = false;
                respawns = 0; // з'єднання було — лічильник спроб більше не потрібен
            }
            Err(e) => {
                if !silent {
                    println!("[sidecar] чекаємо на sidecar ({e})");
                    silent = true; // далі мовчимо, щоб не засмічувати лог
                }

                // Порт нікого не слухає, а наш процес мертвий. Типовий випадок:
                // порт уже зайнятий іншим sidecar, node вийшов з EADDRINUSE — і
                // застосунок лишався без бекенда до повного перезапуску, бо цикл
                // перепідключення підіймає лише сокет, а не процес.
                //
                // Умова саме така (не слухає НІХТО + процес мертвий): якщо порт
                // тримає чужий sidecar, pump() під'єднається до нього успішно, і
                // ми не будемо плодити процеси, які однаково впадуть.
                if !state.external && child_exited(&state) {
                    let backoff = RESPAWN_BACKOFF
                        .saturating_mul(2u32.saturating_pow(respawns.min(4)))
                        .min(MAX_RESPAWN_BACKOFF);
                    tokio::time::sleep(backoff).await;
                    respawns = respawns.saturating_add(1);
                    println!(
                        "[sidecar] процес node не працює — запускаємо знову (спроба {respawns}, пауза {backoff:?})"
                    );
                    let child = spawn_child(layout());
                    *state.child.lock().unwrap() = child;
                    silent = false;
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
    *slot = spawn_child(layout());
    match slot.as_ref() {
        Some(c) => Ok(json!({"restarted": true, "pid": c.id()})),
        None => Err("не вдалося запустити node".into()),
    }
}

#[tauri::command]
pub fn sidecar_status(state: State<'_, Arc<Sidecar>>) -> Value {
    state.status_value()
}

/// Прибрати дочірній sidecar при виході застосунку.
///
/// Без цього процес лишався жити сиротою після закриття вікна: тримав порт
/// (наступний запуск падав з EADDRINUSE), тримав файл-замок і міг далі писати
/// в базу. `Child` у std не вбиває процес при знищенні — це доводиться робити руками.
///
/// Спершу SIGTERM: `server.js` має на нього обробник, який віддає замок і
/// закриває з'єднання. Не помер за секунду — SIGKILL, бо тримати вихід
/// застосунку через зависший бекенд не можна.
pub fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<Sidecar>>() else {
        return;
    };
    if state.external {
        return; // процесом керує розробник у своєму терміналі
    }
    let Some(mut child) = state.child.lock().unwrap().take() else {
        return;
    };

    let pid = child.id();
    println!("[sidecar] завершуємо процес node (pid={pid})");
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }

    for _ in 0..20 {
        match child.try_wait() {
            Ok(Some(status)) => {
                println!("[sidecar] node завершився чисто: {status}");
                return;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => {
                eprintln!("[sidecar] не вдалося дочекатися node: {e}");
                break;
            }
        }
    }

    eprintln!("[sidecar] node не вийшов за секунду — SIGKILL");
    let _ = child.kill();
    let _ = child.wait();
}

/// Викликається з setup() застосунку.
pub fn init(app: &AppHandle) {
    // Розкладку резолвимо саме тут, з живим AppHandle: у бандлі без нього не
    // дізнатись ні теки ресурсів, ні теки даних застосунку.
    let layout = LAYOUT.get_or_init(|| resolve_layout(Some(app)));
    println!(
        "[sidecar] розкладка: {} (код: {}, дані: {}, конфіг: {})",
        if layout.bundled { "зібраний застосунок" } else { "режим розробки" },
        layout.root.display(),
        layout.data.display(),
        layout.config.display()
    );

    let cfg = read_config(&layout.config);
    let external = std::env::var("SIDECAR_EXTERNAL").is_ok_and(|v| v == "1");

    let child = if external {
        println!("[sidecar] режим external: підключаємось до вже запущеного сервера");
        None
    } else {
        spawn_child(layout)
    };

    let state = Arc::new(Sidecar {
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
