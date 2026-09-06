/**
 * Файл: src/modules/walkthrough/frontmost.js
 * Опис: Хто зараз попереду — питання до ОС, а не до зору.
 *
 * `frontmost_app()` у Rust відповідає точно ({name, bundleId}); vision-модель
 * іконок програм цього Mac не бачила і впізнати їх не може — вона читає підписи
 * й загальні шаблони інтерфейсу. Тому стани `wrong_window` і `app_not_started`
 * модуль виставляє САМ, ще до того, як торкнутися моделі: підказка «відкрийте
 * Фотографії» не потребує аналізу зображення і не має коштувати десятків секунд.
 *
 * Зіставлення двома шляхами, у такому порядку:
 *   1. `bundleId` — надійний: не залежить від мови системи;
 *   2. назва — запасний шлях, коли bundleId не прийшов. Назва у `frontmost`
 *      локалізована («Фотографії»), а в базі лежить англійська («Photos»),
 *      тож назви порівнюємо нормалізовано, і головне — розбіжність назв НІКОЛИ
 *      не перекриває збіг за bundleId.
 *
 * Локалізовану назву, підтверджену збігом bundleId, сесія запам'ятовує: далі
 * її вистачить і без bundleId.
 */

import path from "path";
import { localized } from "../../i18n/language.js";

/** Нормалізація назви: форма Unicode, регістр, пробіли, суфікс «.app». */
export function normalizeAppName(value) {
  return String(value ?? "")
    .normalize("NFC")
    .trim()
    .replace(/\.app$/i, "")
    .toLocaleLowerCase();
}

/** Усі назви, під якими ми готові впізнати програму сесії. */
function knownNames(session) {
  const names = new Set();
  const add = (value) => {
    const normalized = normalizeAppName(value);
    if (normalized) names.add(normalized);
  };
  add(session.appName);
  // Ім'я бандла на диску: «/System/Applications/Photos.app» → «Photos».
  if (session.appPath) add(path.basename(String(session.appPath), ".app"));
  for (const alias of session.appAliases || []) add(alias);
  return names;
}

/**
 * Чи попереду програма сесії.
 *
 * @param {Object} session - сесія walkthrough (потрібні appId, appName, appPath).
 * @param {{name?: string, bundleId?: string}|null} frontmost - те, що дав `frontmost_app()`.
 * @returns {{provided: boolean, matched: boolean|null, by: string, name: string|null,
 *            bundleId: string|null, learnedAlias: string|null, reason: string}}
 *          `matched === null` означає «ОС нічого не сказала» — вирішує зір, як раніше.
 */
export function matchFrontmost(session, frontmost) {
  const front = frontmost && typeof frontmost === "object" ? frontmost : null;
  const name = front ? String(front.name ?? "").trim() : "";
  const bundleId = front ? String(front.bundleId ?? "").trim() : "";

  if (!name && !bundleId) {
    return {
      provided: false,
      matched: null,
      by: "none",
      name: null,
      bundleId: null,
      learnedAlias: null,
      reason: "параметр frontmost не передано — стан визначає зір",
    };
  }

  const sessionBundleId = String(session.appId ?? "").trim();

  if (bundleId && sessionBundleId) {
    const matched = bundleId.toLowerCase() === sessionBundleId.toLowerCase();
    let learnedAlias = null;
    if (matched && name && !knownNames(session).has(normalizeAppName(name))) {
      // Назва локалізована («Фотографії» проти «Photos» у базі), але bundleId її
      // підтвердив — запам'ятовуємо, щоб надалі впізнавати і без bundleId.
      if (!session.appAliases) session.appAliases = new Set();
      session.appAliases.add(name);
      learnedAlias = name;
    }
    return {
      provided: true,
      matched,
      by: "bundleId",
      name: name || null,
      bundleId,
      learnedAlias,
      reason: matched
        ? `bundleId «${bundleId}» збігається з програмою сесії`
        : `bundleId «${bundleId}» ≠ «${sessionBundleId}»`,
    };
  }

  if (name) {
    const matched = knownNames(session).has(normalizeAppName(name));
    return {
      provided: true,
      matched,
      by: "name",
      name,
      bundleId: bundleId || null,
      learnedAlias: null,
      reason: matched
        ? `назву «${name}» впізнано серед відомих назв програми сесії`
        : `назви «${name}» немає серед відомих назв «${session.appName}» (bundleId не передано)`,
    };
  }

  return {
    provided: true,
    matched: null,
    by: "none",
    name: null,
    bundleId: bundleId || null,
    learnedAlias: null,
    reason: "у frontmost немає ні назви, ні bundleId — стан визначає зір",
  };
}

/**
 * Готові поля кроку, коли ОС уже дала відповідь. `null` означає «іди до зору».
 *
 * `wrong_window` — попереду інша програма. `app_not_started` кажемо лише тоді,
 * коли ОС прямо повідомила, що цільову програму не запущено (`appRunning:false`
 * з `launch_app()`): здогадуватись про це з самого лише `frontmost` — це та сама
 * помилка, від якої ми тут і йдемо.
 *
 * @param {{session: Object, match: Object, appRunning?: boolean|null, isSelf?: boolean}} args
 */
export function decideFromFrontmost({ session, match, appRunning = null, isSelf = false }) {
  if (!match.provided || match.matched !== false) return null;

  const notes = [`стан визначено з frontmost: ${match.reason}`];
  if (match.by === "name") notes.push("зіставлення за назвою: bundleId не передано");

  if (appRunning === false) {
    notes.push("ОС повідомила, що програму не запущено (appRunning=false)");
    return {
      state: "app_not_started",
      instruction: localized(session.language, {
        uk: `Відкрийте програму «${session.appName}» — вона ще не запущена.`,
        en: `Open “${session.appName}” — the app is not running yet.`,
      }),
      target: null,
      notes,
    };
  }

  const front = match.name || match.bundleId;
  if (isSelf) notes.push("попереду наше ж вікно підказки (isSelf)");
  return {
    state: "wrong_window",
    instruction: localized(session.language, {
      uk: isSelf
        ? `Перейдіть у вікно програми «${session.appName}» — зараз попереду вікно підказки.`
        : `Перейдіть у вікно програми «${session.appName}» — зараз попереду «${front}».`,
      en: isSelf
        ? `Switch to “${session.appName}” — the guide window is currently in front.`
        : `Switch to “${session.appName}” — “${front}” is currently in front.`,
    }),
    target: null,
    notes,
  };
}
