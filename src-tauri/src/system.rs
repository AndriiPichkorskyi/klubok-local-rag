// Системний шар модуля walkthrough (контракт docs/contracts/walkthrough.md):
// знімок екрана, запуск програми, вікно підказки й рамка підсвічування.
// Предметної логіки тут немає: зображення аналізує vision-модель у Node,
// кроки теж рахує Node. Rust робить системний виклик і повертає факти.
//
// Платформозалежне зібрано в модулі `platform`: macOS робочий, решта ОС —
// чесна відмова з поясненням, а не імітація роботи.

use std::path::{Path, PathBuf};
use std::sync::Once;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::sidecar::find_root;

/// Мітки вікон оверлея. Ті самі значення перелічені в `capabilities/default.json`:
/// без цього вікно створиться, але не матиме права слухати події Tauri.
const HINT_LABEL: &str = "walkthrough-hint";
const HIGHLIGHT_LABEL: &str = "walkthrough-highlight";
/// Вікно підказки: розмір і відступ від краю екрана, логічні точки.
/// Ширина взята з `src/walkthrough/walkthrough.css` (панель — до 460 px).
const HINT_W: f64 = 440.0;
const HINT_H: f64 = 300.0;
const MARGIN: f64 = 24.0;
/// Префікс імені знімка. Прибираємо з теки лише файли з ним: тека користувача.
const SHOT_PREFIX: &str = "walkthrough-";
/// Скільки чекати на pid щойно запущеної програми і як часто перепитувати.
const LAUNCH_WAIT: Duration = Duration::from_secs(4);
const LAUNCH_POLL: Duration = Duration::from_millis(150);
/// Куди вести людину по дозвіл на запис екрана.
const PRIVACY_URL: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const PRIVACY_HINT: &str = "Немає дозволу на запис екрана. Системні параметри → \
Конфіденційність і безпека → Запис екрана: увімкніть цей застосунок і перезапустіть його.";

/// Нормалізований прямокутник 0..1 — єдина форма координат, у якій модель
/// повертає знайдений елемент (контракт, розділ «Система координат»).
#[derive(Debug, Deserialize)]
pub struct BoxNorm {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

// ── Конфіг і тека знімків ───────────────────────────────────────────────────

/// Конфіг читаємо щоразу: `config.reload` міняє його на льоту, а знімок
/// робиться рідко — кешувати нема сенсу.
fn read_config(root: &Path) -> Value {
    std::fs::read_to_string(root.join("config/pipeline.config.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null)
}

/// Тека знімків береться з конфіга; відносний шлях — від кореня проєкта.
fn screenshot_dir(root: &Path, cfg: &Value) -> PathBuf {
    let raw = cfg["walkthrough"]["screenshotDir"]
        .as_str()
        .unwrap_or("./sidecar/data/screenshots");
    let dir = PathBuf::from(raw);
    if dir.is_absolute() {
        dir
    } else {
        root.join(dir)
    }
}

/// Знімки попереднього сеансу прибираються один раз на запуск (контракт,
/// правило 1: знімок не лишається на диску довше за сесію). Свої файли за
/// сесію видаляє Node у `walkthrough.finish`; це — страховка після аварії.
fn prune_old_shots(dir: &Path) {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(SHOT_PREFIX) && name.ends_with(".png") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    });
}

fn stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// ── Чиста логіка: перевіряється тестами на будь-якій ОС ─────────────────────

/// Розмір PNG із заголовка IHDR: 8 байтів підпису, 4 довжина, 4 тип «IHDR»,
/// далі ширина й висота big-endian. Беремо саме розмір ФАЙЛА, а не екрана:
/// знімок вікна менший за екран, а Node рахує коефіцієнт зменшення від
/// справжніх пікселів знімка.
fn png_size(head: &[u8]) -> Option<(u32, u32)> {
    if head.len() < 24 || &head[..8] != b"\x89PNG\r\n\x1a\n" || &head[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes([head[16], head[17], head[18], head[19]]);
    let height = u32::from_be_bytes([head[20], head[21], head[22], head[23]]);
    (width > 0 && height > 0).then_some((width, height))
}

/// Нормалізовані координати → логічні точки екрана. Множник знімка сюди не
/// потрапляє навмисно: 0..1 переживає і зменшення картинки, і зміну
/// роздільності, і саме тому контракт вимагає від моделі саме нормалізовані
/// координати. Виходи за межі екрана підрізаємо, нульову рамку не показуємо.
fn box_to_rect(b: &BoxNorm, origin: (f64, f64), screen: (f64, f64)) -> (f64, f64, f64, f64) {
    let (screen_w, screen_h) = (screen.0.max(2.0), screen.1.max(2.0));
    let w = (b.w * screen_w).clamp(2.0, screen_w);
    let h = (b.h * screen_h).clamp(2.0, screen_h);
    let x = origin.0 + (b.x * screen_w).clamp(0.0, screen_w - w);
    let y = origin.1 + (b.y * screen_h).clamp(0.0, screen_h - h);
    (x, y, w, h)
}

/// Розбір виводу системних утиліт macOS. Від ОС не залежить, тому лежить тут
/// і перевіряється тестами (`mod tests`), а не лише на машині користувача.
///
/// Головне правило модуля: **краще None, ніж сміття**. Вивід `lsappinfo` між
/// версіями macOS міняє форму, і жодне значення з нього не можна брати на віру:
/// узяте наосліп перше слово після «=» вже давало користувачеві назву програми
/// «[» — фрагмент розмітки, а не назву (див. `scalar_value` і `clean_name`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod parse {
    /// Аргументи для `open`. Три випадки: шлях до пакета, ідентифікатор пакета
    /// (`com.apple.Safari`) і людська назва («Safari»). Плутати їх не можна:
    /// `open -b` зі шляхом мовчки нічого не зробить.
    pub fn open_args(app_id: &str) -> Vec<String> {
        let id = app_id.trim();
        if id.starts_with('/') || id.starts_with('~') || id.ends_with(".app") {
            vec![id.to_string()]
        } else if is_bundle_id(id) {
            vec!["-b".to_string(), id.to_string()]
        } else {
            vec!["-a".to_string(), id.to_string()]
        }
    }

    /// Ідентифікатор пакета: крапки, без пробілів і роздільників шляху.
    pub fn is_bundle_id(id: &str) -> bool {
        id.contains('.')
            && !id.contains(' ')
            && !id.contains('/')
            && id.split('.').all(|part| !part.is_empty())
    }

    /// Значення поля — і тільки якщо це справді ЗНАЧЕННЯ, а не початок структури.
    ///
    /// `lsappinfo` пише скаляри двома способами: у лапках (`bundleID="com.apple.Photos"`)
    /// і без них (`pid = 4711 ( in path: … )`, `arch=x86_64`). Але тим самим «=»
    /// відкриваються й списки та словники — `"LSDisplayName" = [`, `StatusLabel={`.
    /// Стара версія брала в таких рядках перше слово і віддавала його як значення:
    /// звідси й узялося «[» у тексті для користувача. Тому перше слово годиться
    /// лише тоді, коли в ньому є хоч одна літера чи цифра.
    fn scalar_value(raw: &str) -> Option<String> {
        let value = raw.trim();
        if let Some(rest) = value.strip_prefix('"') {
            let inner = rest.split('"').next().unwrap_or_default();
            return (!inner.trim().is_empty()).then(|| inner.to_string());
        }
        let token = value
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .trim_end_matches(',')
            .trim_end_matches(';');
        // `[`, `{`, `(`, `<` — початок списку чи словника: саме значення лежить
        // на наступних рядках, і взяти дужку за назву програми не можна.
        if token.is_empty() || !token.chars().any(char::is_alphanumeric) {
            return None;
        }
        Some(token.to_string())
    }

    /// Значення поля з виводу `lsappinfo`. Формат між версіями macOS плаває
    /// (`"pid"=123`, `pid = 123`, `bundleID="com.apple.Safari"`), тому розбір
    /// навмисно поблажливий до КЛЮЧА: без лапок і без регістру. До ЗНАЧЕННЯ —
    /// навпаки, суворий: не скаляр — значить, поля немає (None).
    pub fn ls_field(text: &str, key: &str) -> Option<String> {
        for line in text.lines() {
            let Some((raw_key, raw_value)) = line.split_once('=') else {
                continue;
            };
            let found = raw_key.trim().trim_matches('"').trim();
            if !found.eq_ignore_ascii_case(key) {
                continue;
            }
            if let Some(value) = scalar_value(raw_value) {
                return Some(value);
            }
        }
        None
    }

    /// Назва програми із заголовка блоку `lsappinfo info`. Форм дві, і саме на
    /// цьому місці ламався розбір: сучасна macOS пише назву ПЕРЕД ASN, а стара
    /// код читав лише другу форму, тож назва просто губилась (None).
    ///
    /// ```text
    /// "Moom" ASN:0x0-0x13a73a6:            ← сучасна форма
    /// ASN:0x0-0x1e01e-"Safari" ( 0x1e01e ): ← давніша форма
    /// ```
    ///
    /// Рядок `parentASN="loginwindow" ASN:0x0-0x1394393:` — це ASN БАТЬКА, і він
    /// не має права стати відповіддю: заголовок мусить починатися з ASN або з
    /// назви в лапках.
    pub fn header_name(text: &str) -> Option<String> {
        for line in text.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix('"') {
                let Some((name, tail)) = rest.split_once('"') else {
                    continue;
                };
                if tail.trim_start().starts_with("ASN:") && !name.trim().is_empty() {
                    return Some(name.to_string());
                }
                continue;
            }
            if line.starts_with("ASN:") {
                if let Some(name) = line
                    .split_once('"')
                    .and_then(|(_, rest)| rest.split_once('"'))
                    .map(|(name, _)| name)
                {
                    if !name.trim().is_empty() {
                        return Some(name.to_string());
                    }
                }
            }
        }
        None
    }

    /// Сам ASN із заголовка (`lsappinfo find`, `lsappinfo front`). Обидві форми
    /// заголовка, ASN батька не береться — з тієї ж причини, що й у header_name.
    pub fn asn_token(text: &str) -> Option<String> {
        for line in text.lines() {
            let line = line.trim();
            let rest = if line.starts_with("ASN:") {
                line
            } else if let Some(tail) = line
                .strip_prefix('"')
                .and_then(|rest| rest.split_once('"'))
                .map(|(_, tail)| tail.trim_start())
                .filter(|tail| tail.starts_with("ASN:"))
            {
                tail
            } else {
                continue;
            };
            // Беремо рядок ЦІЛКОМ від «ASN:»: у давнішій формі всередині ASN
            // стоїть назва в лапках («ASN:0x0-0x1e01e-"Photo Booth" ( … ):»), і
            // розрив по пробілу зробив би з робочого ASN сміття.
            let token = rest.trim();
            if !token.is_empty() {
                return Some(token.to_string());
            }
        }
        None
    }

    /// Назва пакета зі шляху: «/System/Applications/Photos.app» → «Photos».
    /// Шлях до виконуваного файла теж годиться — беремо саме компонент `.app`,
    /// бо він і є те, що людина бачить у Dock.
    pub fn bundle_name(path: &str) -> Option<String> {
        let app = path
            .split('/')
            .rev()
            .find(|part| part.len() > 4 && part.to_ascii_lowercase().ends_with(".app"));
        match app {
            Some(part) => Some(part[..part.len() - 4].to_string()),
            None => path
                .rsplit('/')
                .next()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string),
        }
    }

    /// Чи можна ЦЕ показати людині як назву програми.
    ///
    /// Порожнє, самі розділові знаки, службові символи, шматок розмітки на
    /// кшталт «[» чи «{» — усе це не назва. Краще чесне None (вікно скаже
    /// «інша програма»), ніж «зараз попереду «[»».
    pub fn clean_name(raw: &str) -> Option<String> {
        let name = raw.trim().trim_matches('"').trim().trim_end_matches(':').trim();
        if name.is_empty() || name.chars().count() > 64 {
            return None;
        }
        if name.chars().any(char::is_control) {
            return None;
        }
        // Хоч одна літера або цифра — інакше це розмітка, а не назва.
        if !name.chars().any(char::is_alphanumeric) {
            return None;
        }
        // Початок структури: значення поля лишилось на наступному рядку.
        if name.starts_with(['[', '{', '(', '<', '=', ',', ';']) {
            return None;
        }
        Some(name.to_string())
    }

    /// Назва активної програми з повного виводу `lsappinfo info`.
    ///
    /// Джерел кілька, бо жодне не є в усіх версіях macOS: поля `LSDisplayName`
    /// у повному виводі може не бути взагалі (воно є у `info -only name`),
    /// заголовок міняв форму, а шлях до пакета лишається завжди. Кожен кандидат
    /// проходить `clean_name` окремо: зіпсований кандидат не зупиняє пошук, а
    /// пропускає хід наступному.
    pub fn app_display_name(info: &str) -> Option<String> {
        let candidates = [
            ls_field(info, "LSDisplayName"),
            ls_field(info, "CFBundleName"),
            header_name(info),
            ls_field(info, "bundle path").as_deref().and_then(bundle_name),
            ls_field(info, "bundlePath").as_deref().and_then(bundle_name),
            ls_field(info, "executable path").as_deref().and_then(bundle_name),
        ];
        candidates
            .into_iter()
            .flatten()
            .find_map(|candidate| clean_name(&candidate))
    }
}

// ── Адаптер macOS ───────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod platform {
    use super::parse::{
        app_display_name, asn_token, clean_name, header_name, is_bundle_id, ls_field, open_args,
    };
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::access::ScreenCaptureAccess;
    use core_graphics::window::{
        create_description_from_array, create_window_list, kCGNullWindowID,
        kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly, kCGWindowLayer,
        kCGWindowNumber, kCGWindowOwnerPID,
    };
    use std::path::Path;
    use std::process::Command;

    /// Чи дано дозвіл на запис екрана. Питаємо систему прямо
    /// (`CGPreflightScreenCaptureAccess`), бо без дозволу macOS не відмовляє:
    /// `screencapture` віддає шпалери без чужих вікон — знімок, який виглядає
    /// робочим. Мовчазний брак тут гірший за помилку.
    pub fn screen_permission() -> Option<bool> {
        Some(ScreenCaptureAccess::default().preflight())
    }

    /// Одноразове системне вікно з проханням дати дозвіл. Далі macOS його вже
    /// не показує — тому в відповіді ще й посилання на потрібну панель.
    pub fn request_permission() {
        ScreenCaptureAccess::default().request();
    }

    /// Число з опису вікна (CGWindowList віддає CFDictionary).
    fn number(dict: &CFDictionary<CFString, CFType>, key: CFStringRef) -> Option<i64> {
        let key = unsafe { CFString::wrap_under_get_rule(key) };
        dict.find(&key)?.downcast::<CFNumber>()?.to_i64()
    }

    /// Ідентифікатор переднього вікна, яке належить не нам. Список іде спереду
    /// назад; рівень 0 — звичайні вікна програм (меню й панелі мають вищий).
    /// Свої вікна пропускаємо: вести користувача по власному оверлею безглуздо.
    fn frontmost_window_id() -> Option<u32> {
        let own_pid = std::process::id() as i64;
        let ids = create_window_list(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID,
        )?;
        for window in create_description_from_array(ids)?.iter() {
            if number(&window, unsafe { kCGWindowLayer }) != Some(0) {
                continue;
            }
            if number(&window, unsafe { kCGWindowOwnerPID }) == Some(own_pid) {
                continue;
            }
            if let Some(id) = number(&window, unsafe { kCGWindowNumber }) {
                return Some(id as u32);
            }
        }
        None
    }

    /// Знімок екрана. Повертає режим, у якому знімок ЗРОБЛЕНО: якщо чужого
    /// переднього вікна немає, чесно кажемо, що зняли весь екран.
    pub fn capture(mode: &str, path: &Path) -> Result<String, String> {
        let mut command = Command::new("/usr/sbin/screencapture");
        command.arg("-x"); // без звуку затвора: знімок робиться на кожному кроці
        let used = match (mode, frontmost_window_id()) {
            ("window", Some(id)) => {
                // -o прибирає тінь вікна: вона не частина інтерфейсу.
                command.args(["-o", "-l", &id.to_string()]);
                "window"
            }
            // -m лише головний дисплей: інакше screencapture пише кілька файлів.
            _ => {
                command.arg("-m");
                "fullscreen"
            }
        };
        let output = command
            .args(["-t", "png"])
            .arg(path)
            .output()
            .map_err(|e| format!("не вдалося запустити screencapture: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "screencapture завершився помилкою: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(used.to_string())
    }

    /// `lsappinfo` — штатна утиліта LaunchServices. На відміну від osascript
    /// вона не потребує дозволу на керування комп'ютером.
    fn lsappinfo(args: &[&str]) -> Option<String> {
        let output = Command::new("/usr/bin/lsappinfo").args(args).output().ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).to_string())
    }

    /// Повний опис програми за її ASN.
    fn describe(asn: &str) -> Option<String> {
        lsappinfo(&["info", asn])
    }

    /// Програма, вікно якої зараз попереду: назва, ідентифікатор пакета, pid.
    ///
    /// Назва тут — необов'язкова величина, і це принципово: `None` чесно каже
    /// «система назви не дала», і вікно підказки напише «інша програма».
    /// Підставити замість назви шматок виводу (те саме «[») означало б збрехати
    /// людині там, де ОС просто змовчала.
    pub fn frontmost() -> Result<(Option<String>, Option<String>, Option<i64>), String> {
        let front = lsappinfo(&["front"]).ok_or("lsappinfo front не відповів")?;
        let asn = front.trim().to_string();
        if asn.is_empty() {
            return Err("lsappinfo не назвав активну програму".into());
        }
        let info = describe(&asn).unwrap_or_default();
        // Останній запасний шлях — сам вивід `lsappinfo front`: у давнішій формі
        // ASN назва вписана прямо в нього (`ASN:0x0-0x1e01e-"Safari"`).
        let name = app_display_name(&info)
            .or_else(|| header_name(&front).as_deref().and_then(clean_name));
        // Ідентифікатор пакета або справжній, або жодного: за ним бекенд
        // вирішує, чи попереду потрібна програма, і сміття тут дорожче за None.
        let bundle_id = ls_field(&info, "bundleID").filter(|id| is_bundle_id(id));
        Ok((
            name,
            bundle_id,
            ls_field(&info, "pid").and_then(|v| v.parse().ok()),
        ))
    }

    /// pid уже запущеної програми або None. Помилка означає, що спитати не
    /// вдалося взагалі, а не що програма не запущена.
    pub fn running_pid(app_id: &str) -> Result<Option<i64>, String> {
        let query = if is_bundle_id(app_id) {
            format!("bundleid={app_id}")
        } else {
            format!("name={}", app_name(app_id))
        };
        let Some(found) = lsappinfo(&["find", &query]) else {
            return Err("lsappinfo find не відповів".into());
        };
        // Заголовок теж буває двох форм («ASN:0x0-…» і «"Photos" ASN:0x0-…»),
        // тому ASN дістаємо тим самим розбором, що й для активної програми.
        let Some(asn) = asn_token(&found) else {
            return Ok(None);
        };
        let info = describe(&asn).unwrap_or_default();
        Ok(ls_field(&info, "pid").and_then(|v| v.parse().ok()))
    }

    /// Назва програми для пошуку: зі шляху беремо ім'я пакета без розширення.
    fn app_name(app_id: &str) -> String {
        Path::new(app_id)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| app_id.to_string())
    }

    /// Запуск або виведення наперед — це те саме `open`: для walkthrough
    /// потрібно, щоб програма була попереду, навіть якщо вона вже працювала.
    pub fn launch(app_id: &str) -> Result<(), String> {
        let output = Command::new("/usr/bin/open")
            .args(open_args(app_id))
            .output()
            .map_err(|e| format!("не вдалося запустити open: {e}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "open не зміг відкрити «{app_id}»: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }
}

// ── Заглушки для решти ОС ───────────────────────────────────────────────────

#[cfg(not(target_os = "macos"))]
mod platform {
    use std::path::Path;

    /// Чесна відмова замість імітації: зрозуміла помилка краща за знімок
    /// нізвідки чи «успішний» запуск, якого не було.
    fn unsupported<T>(what: &str) -> Result<T, String> {
        Err(format!(
            "{what}: системну частину walkthrough реалізовано лише для macOS, поточна ОС — {}",
            std::env::consts::OS
        ))
    }

    /// None = питання про дозвіл на цій ОС не має сенсу.
    pub fn screen_permission() -> Option<bool> {
        None
    }

    pub fn request_permission() {}

    pub fn capture(_mode: &str, _path: &Path) -> Result<String, String> {
        unsupported("знімок екрана")
    }

    pub fn frontmost() -> Result<(Option<String>, Option<String>, Option<i64>), String> {
        unsupported("визначення активної програми")
    }

    pub fn running_pid(_app_id: &str) -> Result<Option<i64>, String> {
        unsupported("перевірка, чи програма запущена")
    }

    pub fn launch(_app_id: &str) -> Result<(), String> {
        unsupported("запуск програми")
    }
}

// ── Команди Tauri ───────────────────────────────────────────────────────────

/// Знімок екрана разом із метаданими, без яких координати від vision-моделі
/// неможливо перевести назад в екранні (контракт, «Система координат»).
/// Відсутній дозвіл повертається відмовою з поясненням, куди натиснути:
/// `src/walkthrough/tauri.js` розпізнає її як `ScreenPermissionError` і показує
/// текст людині. Мовчазний знімок без чужих вікон був би гіршим за відмову.
#[tauri::command]
pub async fn screen_capture(app: AppHandle, mode: Option<String>) -> Result<Value, String> {
    let root = find_root();
    let cfg = read_config(&root);
    let mode = mode
        .or_else(|| {
            cfg["walkthrough"]["captureMode"]
                .as_str()
                .map(str::to_string)
        })
        .unwrap_or_else(|| "window".to_string());

    if platform::screen_permission() == Some(false) {
        platform::request_permission();
        return Err(format!("{PRIVACY_HINT} Панель налаштувань: {PRIVACY_URL}"));
    }

    let dir = screenshot_dir(&root, &cfg);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("не вдалося створити теку знімків {}: {e}", dir.display()))?;
    prune_old_shots(&dir);

    let path = dir.join(format!("{SHOT_PREFIX}{}-{}.png", std::process::id(), stamp()));
    let used = platform::capture(&mode, &path).inspect_err(|_| {
        let _ = std::fs::remove_file(&path);
    })?;

    let (width_px, height_px) = read_png_size(&path).ok_or_else(|| {
        let _ = std::fs::remove_file(&path);
        format!("знімок {} не з'явився або не є PNG", path.display())
    })?;

    let monitor = app.primary_monitor().ok().flatten();
    let scale_factor = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
    let logical = monitor
        .as_ref()
        .map(|m| m.size().to_logical::<f64>(scale_factor));

    Ok(json!({
        "path": path.to_string_lossy(),
        "widthPx": width_px,
        "heightPx": height_px,
        "scaleFactor": scale_factor,
        // Логічний розмір екрана — третій простір координат із контракту:
        // у ньому живуть курсор і вікна, і в нього ж Node переводить рамку.
        "screenWidthPt": logical.map(|s| s.width),
        "screenHeightPt": logical.map(|s| s.height),
        "mode": used,
        "requestedMode": mode,
        "permission": "granted",
    }))
}

/// Заголовок PNG з диска: 24 байтів достатньо, читати кадр цілком не треба.
fn read_png_size(path: &Path) -> Option<(u32, u32)> {
    use std::io::Read;
    let mut head = [0u8; 24];
    let mut file = std::fs::File::open(path).ok()?;
    file.read_exact(&mut head).ok()?;
    png_size(&head)
}

/// Запуск програми або виведення її наперед.
#[tauri::command]
pub async fn launch_app(app_id: String) -> Result<Value, String> {
    let before = platform::running_pid(&app_id)?;
    platform::launch(&app_id)?;

    // Щойно запущена програма отримує pid не миттєво, тому коротко чекаємо.
    let mut pid = before;
    let deadline = Instant::now() + LAUNCH_WAIT;
    while pid.is_none() && Instant::now() < deadline {
        tokio::time::sleep(LAUNCH_POLL).await;
        pid = platform::running_pid(&app_id).unwrap_or(None);
    }

    Ok(json!({
        "launched": before.is_none(),
        "alreadyRunning": before.is_some(),
        "pid": pid,
    }))
}

/// Яка програма зараз попереду. Потрібно, щоб не вести користувача до кнопки
/// у вікні, якого на екрані немає (`state: "wrong_window"` у контракті).
#[tauri::command]
pub async fn frontmost_app() -> Result<Value, String> {
    let (name, bundle_id, pid) = platform::frontmost()?;
    Ok(json!({
        "name": name,
        "bundleId": bundle_id,
        "pid": pid,
        // Попереду ми самі — значить, користувач ще не перейшов у цільову програму.
        "isSelf": pid == Some(std::process::id() as i64),
    }))
}

/// Показати вікно підказки.
#[tauri::command]
pub async fn overlay_show(app: AppHandle) -> Result<Value, String> {
    let window = match app.get_webview_window(HINT_LABEL) {
        Some(window) => window,
        None => build_hint(&app)?,
    };
    window
        .show()
        .map_err(|e| format!("не вдалося показати вікно підказки: {e}"))?;
    Ok(json!({"shown": true, "label": HINT_LABEL}))
}

/// Сховати підказку разом із рамкою: рамка, що лишилась висіти поверх екрана
/// після завершення сесії, — гірше, ніж її відсутність.
#[tauri::command]
pub async fn overlay_hide(app: AppHandle) -> Result<Value, String> {
    let mut hidden = Vec::new();
    for label in [HINT_LABEL, HIGHLIGHT_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            window
                .hide()
                .map_err(|e| format!("не вдалося сховати вікно «{label}»: {e}"))?;
            hidden.push(label);
        }
    }
    Ok(json!({"hidden": hidden}))
}

/// Рамка поверх екрана. `box` — нормалізовані 0..1 координати у просторі
/// знімка ЕКРАНА; для знімка окремого вікна екранного відповідника немає,
/// тому підсвічування вимагає `captureMode: "fullscreen"`.
/// `box: null` — прибрати рамку.
#[tauri::command]
pub async fn overlay_highlight(app: AppHandle, r#box: Option<BoxNorm>) -> Result<Value, String> {
    let cfg = read_config(&find_root());
    if !cfg["walkthrough"]["enableHighlight"]
        .as_bool()
        .unwrap_or(false)
    {
        return Ok(json!({
            "shown": false,
            "reason": "walkthrough.enableHighlight вимкнено в конфізі",
        }));
    }

    let Some(target) = r#box else {
        if let Some(window) = app.get_webview_window(HIGHLIGHT_LABEL) {
            let _ = window.hide();
        }
        return Ok(json!({"shown": false, "reason": "рамку прибрано"}));
    };

    let (origin, screen) = primary_logical(&app)?;
    let (x, y, w, h) = box_to_rect(&target, origin, screen);

    let window = match app.get_webview_window(HIGHLIGHT_LABEL) {
        Some(window) => window,
        None => build_highlight(&app)?,
    };
    window
        .set_position(tauri::LogicalPosition::new(x, y))
        .and_then(|_| window.set_size(tauri::LogicalSize::new(w, h)))
        .and_then(|_| window.show())
        .map_err(|e| format!("не вдалося показати рамку: {e}"))?;

    Ok(json!({"shown": true, "x": x, "y": y, "width": w, "height": h}))
}

// ── Вікна оверлея ───────────────────────────────────────────────────────────

/// Початок координат і розмір головного екрана в логічних точках.
fn primary_logical(app: &AppHandle) -> Result<((f64, f64), (f64, f64)), String> {
    let monitor = app
        .primary_monitor()
        .map_err(|e| format!("не вдалося опитати монітор: {e}"))?
        .ok_or("система не назвала головний монітор")?;
    let scale = monitor.scale_factor();
    let position = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    Ok(((position.x, position.y), (size.width, size.height)))
}

/// Вікно підказки. Головне тут — фокус: користувач працює в цільовій програмі,
/// і якщо наше вікно перехопить фокус, наступне натискання піде не туди.
/// `focused(false)` не дає забрати фокус при появі, `focusable(false)` — при
/// кліку по вікну, `accept_first_mouse(true)` лишає кнопки натискними.
/// Ціна: у вікні підказки не працює введення з клавіатури, і воно там не треба.
fn build_hint(app: &AppHandle) -> Result<WebviewWindow, String> {
    let (origin, screen) = primary_logical(app)?;
    let x = origin.0 + screen.0 - HINT_W - MARGIN;
    let y = origin.1 + screen.1 - HINT_H - MARGIN;
    // Окрема сторінка застосунку (`overlay.html` + вхід `src/walkthrough/main.jsx`),
    // а не маршрут головного вікна: маленькому вікну не потрібні ні пошук,
    // ні панель розробника.
    WebviewWindowBuilder::new(app, HINT_LABEL, WebviewUrl::App("overlay.html".into()))
        .title("Підказка")
        .inner_size(HINT_W, HINT_H)
        .position(x, y)
        .resizable(true)
        .decorations(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .accept_first_mouse(true)
        // Власне вікно не має потрапляти у власні ж знімки: інакше модель почне
        // читати нашу підказку замість інтерфейсу програми.
        .content_protected(true)
        .build()
        .map_err(|e| format!("не вдалося створити вікно підказки: {e}"))
}

/// Рамка: прозоре вікно без рамок, крізь яке проходять кліки — інакше воно
/// перекриє саме той елемент, на який показує. Сторінка та сама, що й у
/// підказки, але з міткою `?overlay=highlight`: намалювати саму рамку — справа
/// фронтенду (зараз `walkthrough.enableHighlight` вимкнено, і вікна не буде).
fn build_highlight(app: &AppHandle) -> Result<WebviewWindow, String> {
    let window = WebviewWindowBuilder::new(
        app,
        HIGHLIGHT_LABEL,
        WebviewUrl::App("overlay.html?overlay=highlight".into()),
    )
    .title("Підсвічування")
    .inner_size(2.0, 2.0)
    .resizable(true)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .focused(false)
    .focusable(false)
    .visible(false)
    .content_protected(true)
    .build()
    .map_err(|e| format!("не вдалося створити вікно рамки: {e}"))?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|e| format!("рамка не стала прозорою для кліків: {e}"))?;
    Ok(window)
}

// ── Тести чистої логіки ─────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::parse::{
        app_display_name, asn_token, bundle_name, clean_name, header_name, is_bundle_id, ls_field,
        open_args,
    };
    use super::{box_to_rect, png_size, BoxNorm};

    /// Справжній заголовок PNG 2880×1864 — розмір Retina-знімка з контракту.
    fn png_head(width: u32, height: u32) -> Vec<u8> {
        let mut head = b"\x89PNG\r\n\x1a\n".to_vec();
        head.extend_from_slice(&13u32.to_be_bytes());
        head.extend_from_slice(b"IHDR");
        head.extend_from_slice(&width.to_be_bytes());
        head.extend_from_slice(&height.to_be_bytes());
        head
    }

    #[test]
    fn png_size_reads_retina_frame() {
        assert_eq!(png_size(&png_head(2880, 1864)), Some((2880, 1864)));
    }

    #[test]
    fn png_size_rejects_not_png() {
        assert_eq!(png_size(b"not a png at all, really no"), None);
        assert_eq!(png_size(&png_head(0, 1864)), None);
        assert_eq!(png_size(&png_head(2880, 1864)[..20]), None);
    }

    #[test]
    fn box_maps_to_logical_points() {
        // Екран 1440×932 логічних точок, кнопка «Запис» із прикладу контракту.
        let target = BoxNorm { x: 0.82, y: 0.11, w: 0.06, h: 0.04 };
        let (x, y, w, h) = box_to_rect(&target, (0.0, 0.0), (1440.0, 932.0));
        assert!((x - 1180.8).abs() < 0.001, "x = {x}");
        assert!((y - 102.52).abs() < 0.001, "y = {y}");
        assert!((w - 86.4).abs() < 0.001, "w = {w}");
        assert!((h - 37.28).abs() < 0.001, "h = {h}");
    }

    #[test]
    fn box_survives_resolution_change() {
        // Ті самі 0..1 на іншій роздільності дають ту саму частку екрана.
        let target = BoxNorm { x: 0.5, y: 0.5, w: 0.1, h: 0.1 };
        let (x, _, w, _) = box_to_rect(&target, (0.0, 0.0), (3840.0, 2160.0));
        assert!((x / 3840.0 - 0.5).abs() < 1e-9);
        assert!((w / 3840.0 - 0.1).abs() < 1e-9);
    }

    #[test]
    fn box_is_clamped_to_screen_and_never_empty() {
        let outside = BoxNorm { x: 0.98, y: 0.98, w: 0.5, h: 0.5 };
        let (x, y, w, h) = box_to_rect(&outside, (0.0, 0.0), (1440.0, 932.0));
        assert!(x + w <= 1440.0 && y + h <= 932.0, "рамка вилізла за екран");
        let empty = BoxNorm { x: 0.0, y: 0.0, w: 0.0, h: 0.0 };
        let (_, _, w, h) = box_to_rect(&empty, (0.0, 0.0), (1440.0, 932.0));
        assert!(w >= 2.0 && h >= 2.0, "нульова рамка");
    }

    #[test]
    fn box_respects_monitor_origin() {
        // Другий монітор ліворуч від головного: початок координат від'ємний.
        let target = BoxNorm { x: 0.0, y: 0.0, w: 0.1, h: 0.1 };
        let (x, y, _, _) = box_to_rect(&target, (-1920.0, 0.0), (1920.0, 1080.0));
        assert_eq!((x, y), (-1920.0, 0.0));
    }

    #[test]
    fn open_args_tells_path_from_bundle_from_name() {
        assert_eq!(open_args("/Applications/Safari.app"), vec!["/Applications/Safari.app"]);
        assert_eq!(open_args("com.apple.Safari"), vec!["-b", "com.apple.Safari"]);
        assert_eq!(open_args("Safari"), vec!["-a", "Safari"]);
        assert_eq!(open_args("Photo Booth"), vec!["-a", "Photo Booth"]);
        assert_eq!(open_args("  com.apple.TV  "), vec!["-b", "com.apple.TV"]);
    }

    #[test]
    fn bundle_id_is_not_a_file_name() {
        assert!(is_bundle_id("com.apple.finder"));
        assert!(!is_bundle_id("Final Cut Pro"));
        assert!(!is_bundle_id("/Applications/Safari.app"));
        assert!(!is_bundle_id("com..apple"));
        assert!(!is_bundle_id("Safari"));
    }

    // ── Реальні зразки виводу lsappinfo ─────────────────────────────────
    //
    // Джерело зразка MOOM: The Robservatory, «See the launch date and time for
    // any app or process» — дослівний блок `lsappinfo info`. Саме на цій формі
    // (назва СТОЇТЬ ПЕРЕД «ASN:», поля LSDisplayName у повному виводі немає)
    // старий розбір і губив назву, віддаючи None при цілком справному bundleID.

    const MOOM: &str = concat!(
        "\"Moom\" ASN:0x0-0x13a73a6:\n",
        "    bundleID=\"com.manytricks.Moom\"\n",
        "    bundle path=\"/Applications/Moom.app\"\n",
        "    executable path=\"/Applications/Moom.app/Contents/MacOS/Moom\"\n",
        "    pid = 89861 type=\"UIElement\" flavor=3 Version=\"3181\" fileType=\"APPL\" creator=\"????\" Arch=x86_64\n",
        "    parentASN=\"loginwindow\" ASN:0x0-0x1394393:\n",
        "    launch time =  2017/02/13 19:44:11 ( 1 days, 12 hours, 18 minutes, 30.5074 seconds ago )\n",
        "    checkin time = 2017/02/13 19:44:12 ( 1 days, 12 hours, 18 minutes, 30.4539 seconds ago )\n",
        "    launch to checkin time: 0.0534301 seconds\n",
    );

    // Форма, у якій значення поля — не скаляр, а початок списку. Саме вона
    // давала користувачеві назву програми «[»: старий розбір брав перше слово
    // після «=» беззастережно.
    const PHOTOS_BRACKET: &str = concat!(
        "\"Photos\" ASN:0x0-0x9d09d:\n",
        "    bundleID=\"com.apple.Photos\"\n",
        "    bundle path=\"/System/Applications/Photos.app\"\n",
        "    \"LSDisplayName\" = [\n",
        "        \"Photos\"\n",
        "    ]\n",
        "    pid = 4711 ( in path: \"/System/Applications/Photos.app/Contents/MacOS/Photos\" )\n",
        "    StatusLabel = { \"label\"= }\n",
    );

    // Давніша форма заголовка: назва всередині ASN.
    const OLD_HEADER: &str = concat!(
        "ASN:0x0-0x1e01e-\"Photo Booth\" ( 0x1e01e ):\n",
        "    bundleID=\"com.apple.PhotoBooth\"\n",
        "    pid = 4711\n",
    );

    #[test]
    fn ls_field_survives_both_output_shapes() {
        assert_eq!(ls_field(MOOM, "bundleID").as_deref(), Some("com.manytricks.Moom"));
        assert_eq!(ls_field(MOOM, "pid").as_deref(), Some("89861"));
        // Ключ читається без регістру і без лапок — вивід `info -only name`.
        let only = "\"LSDisplayName\"=\"Photo Booth\"\n\"pid\"=832\n";
        assert_eq!(ls_field(only, "lsdisplayname").as_deref(), Some("Photo Booth"));
        assert_eq!(ls_field(only, "pid").as_deref(), Some("832"));
        assert_eq!(ls_field(only, "bundleID"), None);
    }

    #[test]
    fn ls_field_never_returns_markup() {
        // Той самий дефект у найчистішому вигляді: значення почалось списком.
        assert_eq!(ls_field(PHOTOS_BRACKET, "LSDisplayName"), None);
        assert_eq!(ls_field(PHOTOS_BRACKET, "StatusLabel"), None);
        // …і при цьому сусідні справжні поля читаються як раніше.
        assert_eq!(
            ls_field(PHOTOS_BRACKET, "bundleID").as_deref(),
            Some("com.apple.Photos")
        );
        assert_eq!(ls_field(PHOTOS_BRACKET, "pid").as_deref(), Some("4711"));
    }

    #[test]
    fn header_name_reads_both_headers_and_ignores_the_parent() {
        assert_eq!(header_name(MOOM).as_deref(), Some("Moom"));
        assert_eq!(header_name(OLD_HEADER).as_deref(), Some("Photo Booth"));
        // ASN батька в рядку parentASN не має ставати назвою програми.
        assert_ne!(header_name(MOOM).as_deref(), Some("loginwindow"));
        assert_eq!(header_name("pid = 1\n"), None);
        // Вивід `lsappinfo front` давньої форми теж містить назву.
        assert_eq!(
            header_name("ASN:0x0-0x1e01e-\"Safari\"\n").as_deref(),
            Some("Safari")
        );
    }

    #[test]
    fn asn_token_takes_the_app_not_its_parent() {
        assert_eq!(asn_token(MOOM).as_deref(), Some("ASN:0x0-0x13a73a6:"));
        assert_eq!(
            asn_token(OLD_HEADER).as_deref(),
            Some("ASN:0x0-0x1e01e-\"Photo Booth\" ( 0x1e01e ):")
        );
        assert_eq!(asn_token("нічого схожого\n"), None);
    }

    #[test]
    fn bundle_name_is_the_app_bundle_not_the_binary() {
        assert_eq!(bundle_name("/System/Applications/Photos.app").as_deref(), Some("Photos"));
        assert_eq!(
            bundle_name("/Applications/Moom.app/Contents/MacOS/Moom").as_deref(),
            Some("Moom")
        );
        assert_eq!(bundle_name("/usr/libexec/secinitd").as_deref(), Some("secinitd"));
    }

    #[test]
    fn clean_name_keeps_names_and_rejects_markup() {
        assert_eq!(clean_name("Photos").as_deref(), Some("Photos"));
        assert_eq!(clean_name(" \"Фотографії\" ").as_deref(), Some("Фотографії"));
        assert_eq!(clean_name("Photo Booth").as_deref(), Some("Photo Booth"));
        assert_eq!(clean_name("1Password 7").as_deref(), Some("1Password 7"));
        // Те, що бачив користувач, і його рідня.
        assert_eq!(clean_name("["), None);
        assert_eq!(clean_name("{"), None);
        assert_eq!(clean_name("[ \"Photos\" ]"), None);
        assert_eq!(clean_name(""), None);
        assert_eq!(clean_name("   "), None);
        assert_eq!(clean_name("---"), None);
        assert_eq!(clean_name("Ph\u{0}otos"), None);
    }

    #[test]
    fn frontmost_name_survives_the_shapes_that_broke_it() {
        // 1. Форма, на якій назва губилась (frontmost.name = null у прогоні).
        assert_eq!(app_display_name(MOOM).as_deref(), Some("Moom"));
        // 2. Форма, на якій назва читалась як «[».
        let name = app_display_name(PHOTOS_BRACKET);
        assert_ne!(name.as_deref(), Some("["));
        assert_eq!(name.as_deref(), Some("Photos"));
        // 3. Давній заголовок.
        assert_eq!(app_display_name(OLD_HEADER).as_deref(), Some("Photo Booth"));
        // 4. Вивід `info -only name`.
        assert_eq!(
            app_display_name("\"LSDisplayName\"=\"Фотографії\"\n").as_deref(),
            Some("Фотографії")
        );
        // 5. Ні назви, ні шляху — чесне None, а не вигадка.
        assert_eq!(app_display_name("pid = 4711\nflavor=3\n"), None);
        assert_eq!(app_display_name(""), None);
    }
}
