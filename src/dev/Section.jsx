/** Проста картка-секція. Заголовок + місце для кнопок праворуч + тіло. */
export default function Section({ title, hint, actions, children }) {
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
