/**
 * Показ відповіді. Головна рекомендація виділена, альтернативи — компактним
 * списком (бекенд віддає лише їхні назви, тому подробиць у них немає).
 */
import { useEffect, useRef } from "react";
import Markdown from "./markdown";

/** Довгу статтю згортаємо, щоб рекомендація не тонула в тексті. */
const CLAMP_CHARS = 900;

/** Прокручує вибраний елемент у видиму частину вікна. */
function useScrollIntoView(isSelected) {
  const ref = useRef(null);
  useEffect(() => {
    if (isSelected && ref.current) {
      ref.current.scrollIntoView({ block: "nearest" });
    }
  }, [isSelected]);
  return ref;
}

/** Головна рекомендація: назва програми, чому саме вона, кроки з довідки. */
function MainCard({ answer, selected, onSelect, stepsOpen, onToggleSteps }) {
  const ref = useScrollIntoView(selected);
  const longSteps = answer.steps.length > CLAMP_CHARS;
  const clamped = longSteps && !stepsOpen;

  return (
    <article
      ref={ref}
      className="sp-card"
      data-selected={selected ? "true" : "false"}
      onClick={onSelect}
    >
      <span className="sp-label">Найкраще підходить</span>
      <h2 className="sp-app-name">{answer.appName}</h2>

      {answer.reason ? <Markdown className="sp-reason sp-md" text={answer.reason} /> : null}

      {answer.steps ? (
        <div className="sp-steps">
          <div className="sp-doc-title">
            {answer.docTitle ? `З довідки: ${answer.docTitle}` : "З довідки програми"}
          </div>
          <div className={clamped ? "sp-steps-body is-clamped" : "sp-steps-body"}>
            <Markdown className="sp-md" text={answer.steps} />
          </div>
          {longSteps ? (
            <div className="sp-progress-actions">
              <button type="button" onClick={onToggleSteps}>
                {stepsOpen ? "Згорнути статтю" : "Показати статтю повністю"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/** Один рядок списку альтернатив. */
function AlternativeRow({ name, selected, open, onSelect, onToggle, onAskAbout }) {
  const ref = useScrollIntoView(selected);

  return (
    <li ref={ref} className="sp-alt" data-selected={selected ? "true" : "false"}>
      <button
        type="button"
        className="sp-alt-head"
        aria-expanded={open}
        onClick={() => {
          onSelect();
          onToggle();
        }}
      >
        <span className="sp-alt-caret">{open ? "▾" : "▸"}</span>
        <span>{name}</span>
      </button>
      {open ? (
        <div className="sp-alt-body">
          <span className="sp-note">
            Ця програма теж згадується в знайденій документації, але покрокової інструкції
            саме для неї у відповіді немає.
          </span>
          <button type="button" onClick={() => onAskAbout(name)}>
            Перепитати про «{name}»
          </button>
        </div>
      ) : null}
    </li>
  );
}

/** Нічого не знайшлось або запит незрозумілий. Найкращий з поганих збігів не видаємо за відповідь. */
function EmptyResult({ answer, invalid }) {
  return (
    <section className="sp-empty">
      <h2>{invalid ? "Не зрозумів запит" : "Нічого підхожого не знайшлося"}</h2>
      <p className="muted">
        {answer.message ||
          (invalid
            ? "Схоже, у запиті випадкові символи. Спробуйте написати завдання словами."
            : "Серед програм, встановлених на цьому Mac, не знайшлося тієї, що впорається із завданням.")}
      </p>
      <ul className="sp-tips">
        <li>Опишіть саме дію, а не назву програми: «записати відео з екрана» замість «OBS».</li>
        <li>Спробуйте простіші слова або інше формулювання.</li>
        <li>Якщо база знань щойно створена — можливо, документацію ще не завантажено.</li>
      </ul>
      {answer.contextApps.length > 0 ? (
        <p className="sp-seen">Переглянуто документацію: {answer.contextApps.join(", ")}.</p>
      ) : null}
    </section>
  );
}

/** Відповідь є, але движок не зіставив її з конкретною програмою. */
function UncertainResult({ answer }) {
  return (
    <section className="sp-empty">
      <h2>Точної рекомендації немає</h2>
      <p className="muted">
        Модель відповіла, але не вказала, з документації якої програми взято відповідь.
        Тому показуємо текст як є — перевірте його критично.
      </p>
      <Markdown className="sp-md" text={answer.message} />
      {answer.contextApps.length > 0 ? (
        <p className="sp-seen">Переглянуто документацію: {answer.contextApps.join(", ")}.</p>
      ) : null}
    </section>
  );
}

export default function ResultView({
  answer,
  selectedIndex,
  onSelect,
  stepsOpen,
  onToggleSteps,
  openAlts,
  onToggleAlt,
  onAskAbout,
}) {
  if (!answer) return null;

  if (answer.kind === "empty" || answer.kind === "invalid") {
    return (
      <div className="sp-result">
        <EmptyResult answer={answer} invalid={answer.kind === "invalid"} />
      </div>
    );
  }
  if (answer.kind === "uncertain") {
    return (
      <div className="sp-result">
        <UncertainResult answer={answer} />
      </div>
    );
  }

  return (
    <div className="sp-result">
      <MainCard
        answer={answer}
        selected={selectedIndex === 0}
        onSelect={() => onSelect(0)}
        stepsOpen={stepsOpen}
        onToggleSteps={onToggleSteps}
      />

      {answer.alternatives.length > 0 ? (
        <section className="sp-alts">
          <div className="sp-alts-title">Інші програми, що згадувалися у знайденій документації</div>
          <ul className="sp-alts-list">
            {answer.alternatives.map((name, i) => (
              <AlternativeRow
                key={name}
                name={name}
                selected={selectedIndex === i + 1}
                open={openAlts.has(name)}
                onSelect={() => onSelect(i + 1)}
                onToggle={() => onToggleAlt(name)}
                onAskAbout={onAskAbout}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {answer.elapsedMs ? (
        <p className="sp-meta">Пошук зайняв {(answer.elapsedMs / 1000).toFixed(1).replace(".", ",")} с.</p>
      ) : null}
    </div>
  );
}
