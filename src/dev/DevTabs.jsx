/**
 * Смуга вкладок панелі розробника.
 *
 * Патерн tablist з WAI-ARIA, зроблений вручну: жодних UI-бібліотек тут немає
 * і бути не може. Стрілки ← → (та ↑ ↓) ходять по вкладках, Home/End — на край,
 * фокус котиться разом із вибором (roving tabindex: у стрічці фокусується лише
 * активна вкладка), тож розділи перемикаються з клавіатури повністю.
 *
 * Вкладка, на якій ЗАРАЗ щось виконується, позначена крапкою і лічильником:
 * інакше після переходу на іншу вкладку людина забуває, де залишила прогін.
 */
import { useCallback, useRef } from "react";

export default function DevTabs({ tabs, active, onSelect, runningCounts }) {
  const listRef = useRef(null);

  /** Перехід на вкладку за індексом (по колу) з перенесенням фокуса. */
  const move = useCallback(
    (index) => {
      const next = tabs[(index + tabs.length) % tabs.length];
      if (!next) return;
      onSelect(next.id);
      const node = listRef.current?.querySelector(`#dp-tab-${next.id}`);
      if (node) node.focus();
    },
    [onSelect, tabs],
  );

  const onKeyDown = useCallback(
    (event) => {
      const index = tabs.findIndex((tab) => tab.id === active);
      if (index < 0) return;

      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          event.preventDefault();
          move(index + 1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
          event.preventDefault();
          move(index - 1);
          break;
        case "Home":
          event.preventDefault();
          move(0);
          break;
        case "End":
          event.preventDefault();
          move(tabs.length - 1);
          break;
        default:
          break;
      }
    },
    [active, move, tabs],
  );

  return (
    <div
      className="dp-tabs"
      role="tablist"
      aria-label="Розділи панелі розробника"
      title="Стрілки ← → перемикають розділи"
      ref={listRef}
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab) => {
        const running = runningCounts?.[tab.id] || 0;
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            id={`dp-tab-${tab.id}`}
            type="button"
            role="tab"
            className={running > 0 ? "dp-tab dp-tab-busy" : "dp-tab"}
            aria-selected={selected}
            aria-controls={`dp-pane-${tab.id}`}
            aria-label={running > 0 ? `${tab.label} — виконується операцій: ${running}` : undefined}
            tabIndex={selected ? 0 : -1}
            title={running > 0 ? `${tab.hint} · виконується операцій: ${running}` : tab.hint}
            onClick={() => onSelect(tab.id)}
          >
            <span>{tab.label}</span>
            {running > 0 ? (
              <>
                <span className="dp-tab-dot" aria-hidden="true" />
                <span className="dp-tab-count" aria-hidden="true">
                  {running}
                </span>
              </>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
