import { useMemo, useEffect, useRef } from "react";
import { Marked } from "marked";

const md = new Marked({ gfm: true, breaks: true });
md.use({
  renderer: {
    html(token) {
      const raw = typeof token === "string" ? token : (token?.raw ?? token?.text ?? "");
      return String(raw).replace(/</g, "&lt;");
    },
  },
});

function stylePlaceholders(htmlString) {
  // Replace [Іконка/Кнопка: ...] with styled badge
  return htmlString.replace(/\[Іконка\/Кнопка:\s*([^\]]+)\]/g, '<kbd class="sp-icon-badge">$1</kbd>');
}

function toHtml(source) {
  const text = typeof source === "string" ? source : "";
  if (!text.trim()) return "";
  try {
    return stylePlaceholders(md.parse(text));
  } catch {
    return stylePlaceholders(`<p>${text.replace(/</g, "&lt;")}</p>`);
  }
}

export default function Markdown({ text, className, isHtml }) {
  const containerRef = useRef(null);
  
  const html = useMemo(() => {
    if (isHtml) return stylePlaceholders(text);
    return toHtml(text);
  }, [text, isHtml]);

  useEffect(() => {
    if (!containerRef.current) return;
    
    // Знаходимо всі зображення і додаємо обробник помилок для офлайну
    const images = containerRef.current.querySelectorAll("img");
    images.forEach(img => {
      // Якщо картинка вже не завантажилась, або коли не завантажиться
      const handleError = () => {
        const altText = img.getAttribute("alt") || img.getAttribute("aria-label") || img.getAttribute("title") || "зображення";
        const badge = document.createElement("kbd");
        badge.className = "sp-icon-badge";
        badge.textContent = altText;
        if (img.parentNode) {
          img.parentNode.replaceChild(badge, img);
        }
      };
      
      if (img.complete && img.naturalHeight === 0) {
        handleError();
      } else {
        img.addEventListener("error", handleError);
      }
    });
  }, [html]);

  if (!html) return null;
  return <div ref={containerRef} className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
