/**
 * Рендер Markdown з відповіді LLM. Власного парсера не пишемо — бібліотека `marked`.
 * Сирий HTML із документації знешкоджуємо: токен html віддаємо як текст,
 * щоб текст статті ніколи не потрапив у DOM як розмітка.
 */
import { useMemo } from "react";
import { Marked } from "marked";

const md = new Marked({ gfm: true, breaks: true });
md.use({
  renderer: {
    // Будь-який сирий HTML у джерелі показуємо як текст, а не як розмітку.
    html(token) {
      const raw = typeof token === "string" ? token : (token?.raw ?? token?.text ?? "");
      return String(raw).replace(/</g, "&lt;");
    },
  },
});

/** Безпечно перетворює Markdown на HTML; за будь-якої помилки — простий текст. */
function toHtml(source) {
  const text = typeof source === "string" ? source : "";
  if (!text.trim()) return "";
  try {
    return md.parse(text);
  } catch {
    return `<p>${text.replace(/</g, "&lt;")}</p>`;
  }
}

export default function Markdown({ text, className }) {
  const html = useMemo(() => toHtml(text), [text]);
  if (!html) return null;
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
