/** Помилка людською мовою: що сталось і що з цим робити. Без стеків. */
export default function ErrorView({ error, onRetry }) {
  return (
    <section className="sp-error" role="alert">
      <h2>{error?.title || "Пошук не вдався"}</h2>
      <p>{error?.hint}</p>
      <div className="sp-progress-actions">
        <button type="button" className="btn-primary" onClick={onRetry}>
          Спробувати ще раз
        </button>
      </div>
    </section>
  );
}
