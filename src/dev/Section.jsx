/**
 * Проста картка-секція. Заголовок + місце для кнопок праворуч + тіло.
 *
 * `collapsible` робить секцію згорнутою (нативний <details>): це для допоміжних
 * секцій, які потрібні зрідка, але мусять лишитись під рукою. Кнопки з `actions`
 * у згортанні не показуємо — вони б працювали як перемикач секції.
 */
export default function Section({ title, hint, actions, collapsible = false, defaultOpen = false, children }) {
  if (collapsible) {
    return (
      <details className="dp-section dp-section-collapsible" open={defaultOpen}>
        <summary className="dp-section-head">
          <span className="dp-section-title">{title}</span>
          {hint ? <span className="muted dp-small">{hint}</span> : null}
        </summary>
        <div className="dp-section-body">{children}</div>
      </details>
    );
  }

  return (
    <section className="dp-section">
      <header className="dp-section-head">
        <span className="dp-section-title">{title}</span>
        <span className="row">
          {hint ? <span className="muted dp-small">{hint}</span> : null}
          {actions}
        </span>
      </header>
      <div className="dp-section-body">{children}</div>
    </section>
  );
}
