/**
 * Файл: src/services/scraper.service.js
 * Опис: Модуль для парсингу довідкових матеріалів (Apple Support) з інтернету.
 *       Використовує Axios для завантаження HTML та Cheerio для очищення тексту,
 *       зокрема, витягує aria-label та alt для збереження контексту іконок.
 */

import axios from "axios";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { config } from "../config/config.js";

const turndownService = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});

// Видаляємо посилання (залишаємо тільки текст), щоб зекономити токени
turndownService.addRule("remove-links", {
  filter: "a",
  replacement: (content) => content,
});

// Видаляємо зображення повністю з Markdown
turndownService.addRule("remove-images", {
  filter: "img",
  replacement: () => "",
});

class ScraperService {
  constructor() {
    this.delayMs = config.scraper.delayMs;
    this.sessionBytes = 0;
  }

  /**
   * Скидає лічильник завантажених байтів (корисно для нового сеансу завантаження).
   */
  resetSessionStats() {
    this.sessionBytes = 0;
  }

  /**
   * Повертає кількість байтів, завантажених протягом сеансу.
   * @returns {number}
   */
  getSessionBytes() {
    return this.sessionBytes;
  }

  /**
   * Додає паузу після виконання функції, щоб не перевантажувати сервер (rate limiting).
   */
  async runWithPause(fn) {
    try {
      return await fn();
    } finally {
      await new Promise((res) => setTimeout(res, this.delayMs));
    }
  }

  /**
   * Отримує зміст (TOC) довідки для вказаної програми.
   * Фільтрує непотрібні сторінки (ліцензії, зміни).
   *
   * @param {string} hpdProjectIdentifier - Ідентифікатор довідки (наприклад, "imovie").
   * @param {AbortSignal} [signal] - Сигнал скасування; axios уміє переривати запит сам.
   * @returns {Promise<Object[]>} - Масив посилань та заголовків.
   */
  async getToc(hpdProjectIdentifier, signal = null) {
    const url = `https://support.apple.com/uk-ua/guide/${hpdProjectIdentifier}/toc/`;
    return this.runWithPause(async () => {
      try {
        const response = await axios.get(url, {
          timeout: config.scraper.timeoutMs,
          signal: signal || undefined,
        });
        const data = response.data;
        this.sessionBytes += Buffer.byteLength(data, "utf8");

        const $ = cheerio.load(data);
        const toc = [];

        $("#toc-container")
          .find("ul li a")
          .each((_, el) => {
            const link = $(el).attr("href");
            const title = $(el).find("span").first().text().trim();

            if (link && title) {
              // Фільтруємо непотрібні сторінки (ліцензії, авторські права, що нового)
              const lowerTitle = title.toLowerCase();
              const ignoreKeywords = [
                "ліцензія",
                "авторські права",
                "copyright",
                "license",
                "change log",
                "changelog",
                "що нового",
                "what's new",
                "terms of use",
                "умови використання",
              ];

              const shouldIgnore = ignoreKeywords.some((kw) => lowerTitle.includes(kw));

              if (!shouldIgnore) {
                const absoluteLink = link.startsWith("http")
                  ? link
                  : `https://support.apple.com${link}`;
                toc.push({ title, url: absoluteLink });
              }
            }
          });
        
        if (toc.length === 0) {
          // Fallback для програм без багатосторінкового TOC (наприклад Наліпки, Диктофон, Калькулятор)
          const welcomeUrl = $(".localnav-title a").attr("href");
          if (welcomeUrl) {
            // Формуємо повний URL якщо він відносний
            const finalUrl = welcomeUrl.startsWith("http")
              ? welcomeUrl
              : "https://support.apple.com" + welcomeUrl;
            toc.push({ title: "Довідка (Головна сторінка)", url: finalUrl });
          }
        }

        return toc;
      } catch (error) {
        // Скасування — не помилка мережі, мовчки віддаємо порожній результат.
        if (axios.isCancel(error) || error.code === "ERR_CANCELED") return [];
        // Якщо довідки немає (404), просто повертаємо порожній масив
        if (error.response && error.response.status === 404) {
          return [];
        }
        console.error(`Помилка отримання TOC для ${url}:`, error.message);
        return [];
      }
    });
  }

  /**
   * Завантажує сирий HTML-код сторінки.
   *
   * @param {string} url - Адреса сторінки.
   * @param {AbortSignal} [signal] - Сигнал скасування; axios уміє переривати запит сам.
   */
  async fetchRawHtml(url, signal = null) {
    return this.runWithPause(async () => {
      try {
        const response = await axios.get(url, {
          timeout: config.scraper.timeoutMs,
          signal: signal || undefined,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7",
          },
        });

        const data = response.data;
        this.sessionBytes += Buffer.byteLength(data, "utf8");
        return data;
      } catch (error) {
        // Скасування — не помилка: лог тут лише заплутував би користувача.
        if (axios.isCancel(error) || error.code === "ERR_CANCELED") return null;
        console.error(`Помилка отримання HTML ${url}:`, error.message);
        return null;
      }
    });
  }

  /**
   * Очищає HTML-код: видаляє непотрібні теги, замінює іконки на текст, додає пробіли.
   */
  extractMainHtml(data) {
    try {
      const $ = cheerio.load(data);
      let mainContent = $("article");
      if (mainContent.length === 0) mainContent = $("#sections");
      if (mainContent.length === 0) mainContent = $("#content-section");
      if (mainContent.length === 0) mainContent = $("#passion-point-section");
      if (mainContent.length === 0) mainContent = $(".page-content");
      if (mainContent.length === 0) mainContent = $("#main");
      if (mainContent.length === 0) mainContent = $("main");
      if (mainContent.length === 0) mainContent = $("body");

      mainContent.find([
        // link — це <link rel="stylesheet"> Apple: у вікні застосунку він тягнув
        // би їхній CSS поверх наших стилів, та ще й сітьовим запитом.
        "script", "style", "link", "noscript", "nav", "footer", "header", "aside", 
        "[id*='localnav']", "[class*='localnav']", 
        "[id*='globalnav']", "[class*='globalnav']",
        "[id*='feedback']", "[class*='feedback']", 
        "[id*='selector']", "[class*='selector']", 
        "[id*='banner']", "[class*='banner']",
        "[id*='breadcrumb']", "[class*='breadcrumb']",
        ".book.topic-search", ".nojs-version-name", "#toc-hidden-content", 
        "#helpful-rating-wrapper", ".LinkUniversal", ".cis-bar", ".cis-bar-text", ".toggle-toc"
      ].join(", ")).remove();
      

      return mainContent.html();
    } catch (error) {
      console.error('Помилка вилучення HTML:', error.message);
      return null;
    }
  }

  cleanHtmlContent(data) {
    try {
      const $ = cheerio.load(data);

      // Apple Support часто тримає контент у <article>, #sections, або .page-content
      let mainContent = $("article");
      if (mainContent.length === 0) mainContent = $("#sections");
      if (mainContent.length === 0) mainContent = $("#content-section");
      if (mainContent.length === 0) mainContent = $("#passion-point-section");
      if (mainContent.length === 0) mainContent = $(".page-content");
      if (mainContent.length === 0) mainContent = $("#main");
      if (mainContent.length === 0) mainContent = $("main");
      if (mainContent.length === 0) mainContent = $("body");

      // Видаляємо глобальні непотрібні блоки, селектори версій, фідбеки, бокові меню тощо
      mainContent.find([
        "script", "style", "noscript", "nav", "footer", "header", "aside", 
        "[id*='localnav']", "[class*='localnav']", 
        "[id*='globalnav']", "[class*='globalnav']",
        "[id*='feedback']", "[class*='feedback']", 
        "[id*='selector']", "[class*='selector']", 
        "[id*='banner']", "[class*='banner']",
        "[id*='breadcrumb']", "[class*='breadcrumb']",
        ".book.topic-search", ".nojs-version-name", "#toc-hidden-content", 
        "#helpful-rating-wrapper", ".LinkUniversal", ".cis-bar", ".cis-bar-text", ".toggle-toc"
      ].join(", ")).remove();

      

      // Проходимо по всіх елементах, які можуть мати важливий прихований текст (іконки, кнопки, посилання, svg)
      mainContent.find("img, svg, button, a, span").each((_, el) => {
        const $el = $(el);
        const tagName = el.tagName.toLowerCase();

        // Шукаємо текст в aria-label, title або alt
        const hiddenText = $el.attr("aria-label") || $el.attr("title") || $el.attr("alt");

        // Якщо це суто візуальний елемент без власного тексту (img, svg), ми його замінюємо або видаляємо
        if (tagName === "img" || tagName === "svg") {
          if (hiddenText && hiddenText.trim() !== "") {
            $el.replaceWith(` [Іконка/Кнопка: ${hiddenText.trim()}] `);
          } else {
            $el.remove(); // Видаляємо декоративні зображення та SVG
          }
        }
        // Якщо це кнопка або посилання (button, a, span), і в ній НЕМАЄ тексту, але Є aria-label
        else if (
          (tagName === "button" || tagName === "a" || tagName === "span") &&
          $el.text().trim() === ""
        ) {
          if (hiddenText && hiddenText.trim() !== "") {
            $el.text(` [${hiddenText.trim()}] `);
          }
        }
      });

      // Конвертуємо очищений HTML у правильний Markdown
      let markdown = turndownService.turndown(mainContent.html());

      // Додаткове очищення від зайвих пустих рядків
      markdown = markdown
        .replace(/\n{3,}/g, "\n\n") // Залишаємо максимум 2 переноси рядка
        .trim();

      return markdown;
    } catch (error) {
      console.error(`Помилка очищення HTML:`, error.message);
      return null;
    }
  }
}

export const scraper = new ScraperService();
