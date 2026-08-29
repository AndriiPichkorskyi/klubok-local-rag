/**
 * Файл: src/modules/walkthrough/geometry.js
 * Опис: Три системи координат модуля 2.5 і переходи між ними.
 *       Це найчастіше джерело помилок (див. docs/contracts/walkthrough.md),
 *       тому вся арифметика зібрана в одному місці й ніде не дублюється.
 *
 *   1. Пікселі знімка       — 2880×1864 на Retina, це те, що зробив screencapture;
 *   2. Пікселі, надіслані моделі — після зменшення, напр. 1280×828;
 *   3. Логічні точки екрана — 1440×932, ними живе курсор і вікна.
 *
 * Модель бачить простір 2 і тільки його. Назовні (в RPC-відповідь) координати
 * виходять НОРМАЛІЗОВАНИМИ 0..1: така рамка переживає і зміну роздільної
 * здатності, і зміну коефіцієнта зменшення. Перерахунок у точки робить той,
 * хто малює рамку, — функціями нижче і з метаданих знімка.
 */

/** Затискає число в діапазон 0..1. Нечисло — null. */
export function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/**
 * Ознака того, що модель віддала ПІКСЕЛІ замість часток. Найчастіша помилка
 * vision-моделей: у промпті просимо 0..1, а приходить 640 або 0.5 навперемін.
 * Поріг 1.5, а не 1: значення 1.0 (уся ширина) законне, 1.2 — вже сміття.
 */
const PIXEL_HINT_THRESHOLD = 1.5;

/**
 * Приводить рамку від моделі до нормалізованого вигляду 0..1.
 *
 * @param {Object} box - те, що віддала модель: {x, y, w, h}.
 * @param {{width: number, height: number}} sent - розмір НАДІСЛАНОГО зображення.
 * @returns {{box: {x,y,w,h}|null, wasPixels: boolean, reason: string|null}}
 */
export function sanitizeBox(box, sent) {
  if (!box || typeof box !== "object")
    return { box: null, wasPixels: false, reason: "рамки немає" };

  const raw = {
    x: Number(box.x),
    y: Number(box.y),
    w: Number(box.w ?? box.width),
    h: Number(box.h ?? box.height),
  };
  if (!Object.values(raw).every((n) => Number.isFinite(n))) {
    return { box: null, wasPixels: false, reason: "нечислові координати" };
  }

  // Пікселі надісланого зображення переводимо в частки самі: рамка від цього
  // не «їде», а модель отримує право помилитися в одиницях, а не в місці.
  const looksLikePixels = Object.values(raw).some((n) => n > PIXEL_HINT_THRESHOLD);
  let normalized = raw;
  if (looksLikePixels) {
    if (!sent || !(sent.width > 0) || !(sent.height > 0)) {
      return {
        box: null,
        wasPixels: true,
        reason: "координати в пікселях, а розмір кадру невідомий",
      };
    }
    normalized = {
      x: raw.x / sent.width,
      y: raw.y / sent.height,
      w: raw.w / sent.width,
      h: raw.h / sent.height,
    };
  }

  const result = {
    x: clamp01(normalized.x),
    y: clamp01(normalized.y),
    w: clamp01(normalized.w),
    h: clamp01(normalized.h),
  };
  if (Object.values(result).some((n) => n === null)) {
    return { box: null, wasPixels: looksLikePixels, reason: "координати поза межами кадру" };
  }
  // Рамка нульової площі — це «нічого не знайдено», а не елемент.
  if (result.w <= 0 || result.h <= 0) {
    return { box: null, wasPixels: looksLikePixels, reason: "нульова ширина або висота" };
  }
  // Рамка на весь екран не вказує ні на що: це спосіб моделі сказати «не знаю».
  if (result.w >= 0.99 && result.h >= 0.99) {
    return { box: null, wasPixels: looksLikePixels, reason: "рамка на весь кадр" };
  }

  // Обрізаємо вихід за правий/нижній край, щоб рамка лишалась у кадрі.
  result.w = Math.min(result.w, 1 - result.x);
  result.h = Math.min(result.h, 1 - result.y);

  return { box: result, wasPixels: looksLikePixels, reason: null };
}

/**
 * Нормалізована рамка → пікселі ВИХІДНОГО знімка (простір 1).
 * @param {{x,y,w,h}} box
 * @param {{widthPx: number, heightPx: number}} meta - метадані знімка від Rust.
 */
export function boxToScreenshotPixels(box, meta) {
  if (!box || !meta) return null;
  return {
    x: Math.round(box.x * meta.widthPx),
    y: Math.round(box.y * meta.heightPx),
    w: Math.round(box.w * meta.widthPx),
    h: Math.round(box.h * meta.heightPx),
  };
}

/**
 * Нормалізована рамка → логічні точки екрана (простір 3), у яких живе оверлей.
 * @param {{x,y,w,h}} box
 * @param {{widthPx: number, heightPx: number, scaleFactor: number}} meta
 */
export function boxToLogicalPoints(box, meta) {
  if (!box || !meta) return null;
  const scale = Number(meta.scaleFactor) > 0 ? Number(meta.scaleFactor) : 1;
  const logicalWidth = meta.widthPx / scale;
  const logicalHeight = meta.heightPx / scale;
  return {
    x: Math.round(box.x * logicalWidth),
    y: Math.round(box.y * logicalHeight),
    w: Math.round(box.w * logicalWidth),
    h: Math.round(box.h * logicalHeight),
  };
}

/**
 * Пікселі надісланого зображення → нормалізовані частки. Зворотний бік
 * sanitizeBox: потрібен тим, хто вже має рамку в просторі 2.
 */
export function normalizeBox(pixelBox, sentWidth, sentHeight) {
  if (!pixelBox || !(sentWidth > 0) || !(sentHeight > 0)) return null;
  return {
    x: clamp01(pixelBox.x / sentWidth),
    y: clamp01(pixelBox.y / sentHeight),
    w: clamp01(pixelBox.w / sentWidth),
    h: clamp01(pixelBox.h / sentHeight),
  };
}
