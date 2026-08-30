/**
 * Переміщення вікна підказки і пам'ять про його положення.
 *
 * Перетягування робить САМ Tauri: у кожен webview він вставляє скрипт, який на
 * mousedown обходить composedPath і, знайшовши атрибут `data-tauri-drag-region`,
 * викликає `plugin:window|start_dragging`. CSS `-webkit-app-region: drag` тут не
 * працює: це розширення Chromium (Electron), а на macOS Tauri малює у WKWebView.
 * Той самий скрипт сам вимикає перетягування на клікабельних елементах
 * (BUTTON, A, INPUT, [role=button]…), тож кнопки на смузі лишаються натискними;
 * на них ми ще й ставимо `data-tauri-drag-region="false"` — явно і видно з коду.
 * Значення атрибута: без значення = тягне лише сам елемент, `deep` = і вся його
 * середина, `false` = не тягне і блокує предків.
 *
 * Положення І РОЗМІР зберігаємо в ЛОГІЧНИХ точках: фізичні пікселі змінюються
 * разом із масштабом дисплея, і збережене на Retina вікно опинилось би за краєм
 * екрана (а розмір подвоївся б).
 *
 * Розмір тут же, а не окремим файлом, бо це та сама механіка: прочитати зі
 * сховища → підрізати під монітор → віддати вікну → слухати подію і писати назад.
 */
import {
  getCurrentWindow,
  currentMonitor,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";

const KEY = "walkthrough.window.position";
const SIZE_KEY = "walkthrough.window.size";

/**
 * Межі розміру вікна підказки в логічних точках.
 *
 * Нижня межа — щоб вікно не можна було звести до смужки, у якій не видно
 * інструкції. Верхньої межі як числа немає: обмежує монітор (див. clampSize).
 * Значення за замовчуванням збігаються з тими, з якими вікно створює Rust
 * (`HINT_W`/`HINT_H` у src-tauri/src/system.rs) — 440×300.
 */
export const MIN_SIZE = { width: 320, height: 220 };
export const DEFAULT_SIZE = { width: 440, height: 300 };

/** Значення атрибута для смуги заголовка. Одне місце — щоб не розповзалось. */
export const DRAG_REGION = "deep";
/** Явне виключення для кнопок усередині смуги. */
export const NO_DRAG = "false";

function storage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Збережене положення або null. Сміття в сховищі не має ламати вікно. */
export function readPosition() {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return Number.isFinite(value?.x) && Number.isFinite(value?.y)
      ? { x: value.x, y: value.y }
      : null;
  } catch {
    return null;
  }
}

export function writePosition(position) {
  if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return false;
  try {
    storage()?.setItem(KEY, JSON.stringify({ x: Math.round(position.x), y: Math.round(position.y) }));
    return true;
  } catch {
    return false; // приватний режим або вимкнене сховище — не привід падати
  }
}

export function forgetPosition() {
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* нема чого чистити */
  }
}

/** Збережений розмір або null. Сміття в сховищі не має ламати вікно. */
export function readSize() {
  try {
    const raw = storage()?.getItem(SIZE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return Number.isFinite(value?.width) && Number.isFinite(value?.height)
      ? { width: value.width, height: value.height }
      : null;
  } catch {
    return null;
  }
}

export function writeSize(size) {
  if (!Number.isFinite(size?.width) || !Number.isFinite(size?.height)) return false;
  // Вироджений розмір не зберігаємо: наступного запуску вікно було б порожньою
  // смужкою, і людина вирішила б, що підказка зламалась.
  if (size.width < MIN_SIZE.width || size.height < MIN_SIZE.height) return false;
  try {
    storage()?.setItem(
      SIZE_KEY,
      JSON.stringify({ width: Math.round(size.width), height: Math.round(size.height) }),
    );
    return true;
  } catch {
    return false; // приватний режим або вимкнене сховище — не привід падати
  }
}

export function forgetSize() {
  try {
    storage()?.removeItem(SIZE_KEY);
  } catch {
    /* нема чого чистити */
  }
}

/**
 * Підрізання розміру: не менше читабельного мінімуму і не більше за монітор.
 * Чиста функція, як і clampToMonitor: перевіряється без вікна і без ОС.
 */
export function clampSize(size, monitor) {
  const width = Number.isFinite(size?.width) ? size.width : DEFAULT_SIZE.width;
  const height = Number.isFinite(size?.height) ? size.height : DEFAULT_SIZE.height;
  const maxW =
    monitor && Number.isFinite(monitor.width) ? Math.max(MIN_SIZE.width, monitor.width) : Infinity;
  const maxH =
    monitor && Number.isFinite(monitor.height)
      ? Math.max(MIN_SIZE.height, monitor.height)
      : Infinity;
  return {
    width: Math.round(Math.min(Math.max(width, MIN_SIZE.width), maxW)),
    height: Math.round(Math.min(Math.max(height, MIN_SIZE.height), maxH)),
  };
}

/**
 * Підрізання під межі монітора. Збережене положення переживає і від'єднаний
 * другий екран, і зміну роздільності: вікно, яке відновилось за краєм, для
 * людини не існує — вона вирішить, що підказка зламалась.
 * Чиста функція: перевіряється тестом без вікна і без ОС.
 */
export function clampToMonitor(position, monitor, size) {
  if (!monitor || !Number.isFinite(monitor.width) || !Number.isFinite(monitor.height)) {
    return { x: Math.round(position.x), y: Math.round(position.y) };
  }
  const w = Number.isFinite(size?.width) ? size.width : 0;
  const h = Number.isFinite(size?.height) ? size.height : 0;
  const maxX = monitor.x + Math.max(0, monitor.width - w);
  const maxY = monitor.y + Math.max(0, monitor.height - h);
  return {
    x: Math.round(Math.min(Math.max(position.x, monitor.x), maxX)),
    y: Math.round(Math.min(Math.max(position.y, monitor.y), maxY)),
  };
}

/** Чи ми взагалі всередині Tauri. У браузері й у jsdom — ні, і це нормально. */
export function inTauri() {
  try {
    return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
  } catch {
    return false;
  }
}

/**
 * Це вікно підказки, а не прозоре вікно рамки: сторінка `overlay.html` одна на
 * двох, і рамку рухати не можна — її положення рахує Rust із координат моделі.
 */
export function isHintWindow(search = typeof location === "undefined" ? "" : location.search) {
  try {
    return new URLSearchParams(search || "").get("overlay") !== "highlight";
  } catch {
    return true;
  }
}

/** Межі поточного монітора в логічних точках. null, якщо система не відповіла. */
async function monitorBounds() {
  try {
    const monitor = await currentMonitor();
    if (!monitor) return null;
    const scale = monitor.scaleFactor || 1;
    return {
      x: monitor.position.x / scale,
      y: monitor.position.y / scale,
      width: monitor.size.width / scale,
      height: monitor.size.height / scale,
    };
  } catch {
    return null;
  }
}

/**
 * Відновлення положення з минулої сесії. Rust ставить вікно в кут екрана при
 * створенні; якщо автор його вже посував, повертаємо туди, де він лишив.
 * Повертає причину відмови, а не кидає: це зручність, а не умова роботи.
 */
export async function restoreWindowPosition() {
  const saved = readPosition();
  if (!saved) return { restored: false, reason: "збереженого положення немає" };
  if (!inTauri()) return { restored: false, reason: "не в Tauri" };
  try {
    const win = getCurrentWindow();
    const scale = await win.scaleFactor();
    const outer = await win.outerSize();
    const size = typeof outer?.toLogical === "function" ? outer.toLogical(scale) : outer;
    const next = clampToMonitor(saved, await monitorBounds(), size);
    await win.setPosition(new LogicalPosition(next.x, next.y));
    return { restored: true, position: next };
  } catch (error) {
    // Найімовірніша причина — команді `set_position` не видано дозволу в
    // capabilities. Вікно від цього лишається робочим, просто стоїть у кутку.
    return { restored: false, reason: String(error?.message ?? error) };
  }
}

/**
 * Робить вікно розтягуваним і повертає йому збережений розмір.
 *
 * Rust створює вікно з `resizable(false)` і 440×300 — для читання промптів у
 * режимі діагностики цього мало. Вмикаємо розтягування звідси, з вікна, а не
 * правкою Rust: `src-tauri/` — чужа зона, а команди вікна доступні з JS.
 *
 * ВАЖЛИВО: обидві команди мають бути дозволені в
 * `src-tauri/capabilities/default.json` — `core:window:allow-set-resizable` і
 * `core:window:allow-set-size`. Без них команда відмовляє, і функція чесно
 * повертає причину: вікно лишається робочим, просто нерозтягуваним.
 */
export async function restoreWindowSize() {
  if (!inTauri()) return { restored: false, resizable: false, reason: "не в Tauri" };
  let resizable = false;
  try {
    const win = getCurrentWindow();
    await win.setResizable(true);
    resizable = true;
    const saved = readSize();
    if (!saved) return { restored: false, resizable, reason: "збереженого розміру немає" };
    const next = clampSize(saved, await monitorBounds());
    await win.setSize(new LogicalSize(next.width, next.height));
    return { restored: true, resizable, size: next };
  } catch (error) {
    // Найімовірніша причина — команді не видано дозволу в capabilities.
    return { restored: false, resizable, reason: String(error?.message ?? error) };
  }
}

/**
 * Запам'ятовування розміру. Підписка на `tauri://resize` — так само, як
 * положення слухає `tauri://move`. Повертає функцію відписки завжди.
 */
export async function watchWindowSize(onChange) {
  if (!inTauri()) return () => {};
  try {
    const win = getCurrentWindow();
    const scale = await win.scaleFactor();
    return await win.onResized(({ payload }) => {
      const logical =
        typeof payload?.toLogical === "function" ? payload.toLogical(scale) : payload;
      if (!Number.isFinite(logical?.width) || !Number.isFinite(logical?.height)) return;
      const next = { width: Math.round(logical.width), height: Math.round(logical.height) };
      writeSize(next);
      onChange?.(next);
    });
  } catch {
    return () => {};
  }
}

/**
 * Запам'ятовування положення. Підписка на `tauri://move`: подія приходить і
 * після перетягування мишею, і після програмного переміщення.
 * Повертає функцію відписки — завжди, навіть коли підписатись не вдалося.
 */
export async function watchWindowPosition(onChange) {
  if (!inTauri()) return () => {};
  try {
    const win = getCurrentWindow();
    const scale = await win.scaleFactor();
    return await win.onMoved(({ payload }) => {
      const logical =
        typeof payload?.toLogical === "function" ? payload.toLogical(scale) : payload;
      if (!Number.isFinite(logical?.x) || !Number.isFinite(logical?.y)) return;
      const next = { x: Math.round(logical.x), y: Math.round(logical.y) };
      writePosition(next);
      onChange?.(next);
    });
  } catch {
    return () => {};
  }
}
