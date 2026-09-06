import { useTranslation } from "react-i18next";
import { humanizeError } from "./useSearch";

/** Помилка людською мовою: що сталось і що з цим робити. Без стеків. */
export default function ErrorView({ error, onRetry }) {
  const { t } = useTranslation();
  const human = humanizeError(error, t);
  return (
    <section className="sp-error" role="alert">
      <h2>{human.title}</h2>
      <p>{human.hint}</p>
      <div className="sp-progress-actions">
        <button type="button" className="btn-primary" onClick={onRetry}>
          {t("common.retry")}
        </button>
      </div>
    </section>
  );
}
