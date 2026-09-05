import { useCallback, useEffect, useRef, useState } from "react";

/** Межі тягання: жодна з колонок не має зникати повністю. */
const MIN_PERCENT = 20;
const MAX_PERCENT = 80;

/**
 * Розділювач колонок панелі.
 */
export function useSplitter(defaultSize = 60) {
  const [size, setSize] = useState(defaultSize);
  const containerRef = useRef(null);
  /** Останнє застосоване значення: з нього починається наступне тягання. */
  const latestRef = useRef(defaultSize);
  const frameRef = useRef(0);

  // Після коміту (і будь-якої зміни стану) DOM і стан мусять збігатись.
  useEffect(() => {
    latestRef.current = size;
  }, [size]);

  const startDrag = useCallback((event) => {
    event.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const vertical = window.innerWidth <= 900;
    const total = vertical ? container.offsetHeight : container.offsetWidth;
    if (!total) return;

    const startPos = vertical ? event.clientY : event.clientX;
    const startSize = latestRef.current;
    let pending = startSize;

    const apply = (value) => {
      latestRef.current = value;
      container.style.setProperty("--split-size", `${value}%`);
    };

    const onMove = (moveEvent) => {
      const current = vertical ? moveEvent.clientY : moveEvent.clientX;
      const percent = startSize + ((current - startPos) / total) * 100;
      pending = Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, percent));

      if (frameRef.current) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = 0;
        apply(pending);
      });
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
      apply(pending);
      document.body.style.userSelect = "";
      container.classList.remove("is-dragging");
      // Єдиний рендер за все тягання.
      setSize(pending);
    };

    document.body.style.userSelect = "none";
    container.classList.add("is-dragging");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, []);

  // Кадр, замовлений останнім рухом, не має пережити розмонтування.
  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return { size, containerRef, startDrag };
}

export function Splitter({ onPointerDown }) {
  return (
    <div
      className="dp-splitter"
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
    >
      <div className="dp-splitter-icon" />
    </div>
  );
}
