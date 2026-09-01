import { useEffect, useRef, useState } from "react";

export function useSplitter(defaultSize = 60) {
  const [size, setSize] = useState(defaultSize);
  const containerRef = useRef(null);

  const startDrag = (e) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    
    const isVertical = window.innerWidth <= 900;
    const startPos = isVertical ? e.clientY : e.clientX;
    const startSize = size;
    const totalSize = isVertical ? container.offsetHeight : container.offsetWidth;

    const onMove = (ev) => {
      const currentPos = isVertical ? ev.clientY : ev.clientX;
      const delta = currentPos - startPos;
      const deltaPercent = (delta / totalSize) * 100;
      let newSize = startSize + deltaPercent;
      if (newSize < 20) newSize = 20;
      if (newSize > 80) newSize = 80;
      setSize(newSize);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
    };

    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return { size, containerRef, startDrag };
}

export function Splitter({ onPointerDown }) {
  return (
    <div
      className="dp-splitter"
      onPointerDown={onPointerDown}
    >
      <div className="dp-splitter-icon" />
    </div>
  );
}
