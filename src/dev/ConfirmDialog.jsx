/**
 * Власне підтвердження деструктивної дії на React.
 * confirm()/alert()/prompt() не використовуємо: браузерні модалки блокують
 * увесь застосунок, а це прямо суперечить вимозі «інтерфейс не блокується».
 */
import { useEffect, useRef } from "react";
import { dt } from "./i18n";

export default function ConfirmDialog({ title, message, confirmLabel = dt("dialog.confirm"), onConfirm, onCancel }) {
  const cancelRef = useRef(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="dp-overlay" role="dialog" aria-modal="true" onMouseDown={onCancel}>
      <div className="dp-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dp-dialog-title">{title}</div>
        <div className="dp-small">{message}</div>
        <div className="dp-dialog-actions">
          <button type="button" ref={cancelRef} onClick={onCancel}>
            {dt("dialog.cancel")}
          </button>
          <button type="button" className="dp-danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
