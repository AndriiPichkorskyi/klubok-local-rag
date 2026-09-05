import { useEffect, useRef, useState } from "react";
import Markdown from "./markdown";
import WalkthroughLauncher from "../walkthrough/WalkthroughLauncher";

const CLAMP_CHARS = 900;

function useScrollIntoView(isSelected) {
  const ref = useRef(null);
  useEffect(() => {
    if (isSelected && ref.current) {
      ref.current.scrollIntoView({ block: "nearest" });
    }
  }, [isSelected]);
  return ref;
}

/**
 * Єдиний компонент для відображення програми (як головної, так і альтернативних).
 * Якщо isMain=true, він показує причину від LLM та кнопки дій.
 * Якщо isAccordion=true (для альтернатив), він може згортатися/розгортатися.
 */

function AppCard({
  appName,
  isMain,
  reason,
  docs = [],
  selected,
  onSelect,
  askedText,
  onAskAbout,
}) {
  const ref = useScrollIntoView(selected);
  const firstDocTitle = docs?.[0]?.title || "";
  const [expandedDocs, setExpandedDocs] = useState(new Set());

  const toggleDoc = (idx) => {
    setExpandedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const renderDocs = () => {
    if (!docs || docs.length === 0) {
      return (
        <span
          className="sp-note"
          style={{ display: "block", marginBottom: "16px" }}
        >
          Ця програма згадується у контексті, але повної статті немає.
        </span>
      );
    }

    return (
      <div className="sp-steps">
        {docs.map((doc, idx) => {
          const isOpen = expandedDocs.has(idx);
          const textLength = (doc.htmlContent || doc.content).length;

          // Перша стаття частково відкрита (до 900 символів), інші - повністю сховані
          const limit = idx === 0 ? CLAMP_CHARS : 0;
          const isClamped = textLength > limit && !isOpen;

          return (
            <div
              key={idx}
              className="sp-doc-block"
              style={{
                marginTop: idx > 0 ? "16px" : "0",
                borderTop: idx > 0 ? "1px solid var(--line)" : "none",
                paddingTop: idx > 0 ? "16px" : "0",
              }}
            >
              <div className="sp-doc-title">З довідки: {doc.title}</div>

              {(!isClamped || limit > 0) && (
                <div
                  className={
                    isClamped ? "sp-steps-body is-clamped" : "sp-steps-body"
                  }
                >
                  <Markdown
                    className="sp-md"
                    text={doc.htmlContent || doc.content}
                    isHtml={!!doc.htmlContent}
                  />
                </div>
              )}

              {textLength > limit && (
                <div className="sp-progress-actions">
                  <button type="button" onClick={() => toggleDoc(idx)}>
                    {isOpen ? "Згорнути статтю" : "Показати статтю повністю"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <article
      ref={ref}
      className="sp-card"
      data-selected={selected ? "true" : "false"}
      onClick={onSelect}
      style={!isMain ? { marginTop: "16px" } : {}}
    >
      {isMain ? (
        <span className="sp-label">Найкраще підходить</span>
      ) : (
        <span
          className="sp-label"
          style={{ background: "var(--line)", color: "var(--text-muted)" }}
        >
          Також згадується
        </span>
      )}

      <h2 className="sp-app-name">{appName}</h2>

      {isMain && reason ? (
        <Markdown className="sp-reason sp-md" text={reason} />
      ) : null}

      {renderDocs()}

      <div
        onClick={(event) => event.stopPropagation()}
        style={{ display: "flex", gap: "8px", marginTop: "16px" }}
      >
        <WalkthroughLauncher
          appName={appName}
          docTitle={firstDocTitle}
          askedText={askedText}
        />
        {/* {!isMain && (
           <button type="button" className="sp-alt-btn" style={{border: '1px solid var(--line)', background: 'transparent', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer'}} onClick={() => onAskAbout(appName)}>
             Перепитати про «{appName}»
           </button>
        )} */}
      </div>
    </article>
  );
}
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
        <li>
          Опишіть саме дію, а не назву програми: «записати відео з екрана»
          замість «OBS».
        </li>
        <li>Спробуйте простіші слова або інше формулювання.</li>
        <li>
          Якщо база знань щойно створена — можливо, документацію ще не
          завантажено.
        </li>
      </ul>
      {answer.contextApps.length > 0 ? (
        <p className="sp-seen">
          Переглянуто документацію: {answer.contextApps.join(", ")}.
        </p>
      ) : null}
    </section>
  );
}

function UncertainResult({ answer }) {
  return (
    <section className="sp-empty">
      <h2>Точної рекомендації немає</h2>
      <p className="muted">
        Модель відповіла, але не вказала, з документації якої програми взято
        відповідь. Тому показуємо текст як є — перевірте його критично.
      </p>
      <Markdown className="sp-md" text={answer.message} />
      {answer.contextApps.length > 0 ? (
        <p className="sp-seen">
          Переглянуто документацію: {answer.contextApps.join(", ")}.
        </p>
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
  askedText = "",
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
      <AppCard
        isMain={true}
        appName={answer.appName}
        reason={answer.reason}
        docs={answer.mainDocuments}
        selected={selectedIndex === 0}
        onSelect={() => onSelect(0)}
        askedText={askedText}
      />

      {answer.alternatives.length > 0 ? (
        <section className="sp-alts">
          <div className="sp-alts-title">
            Інші програми, що згадувалися у знайденій документації
          </div>
          <ul className="sp-alts-list">
            {answer.alternatives.map((name, i) => (
              <AppCard
                key={name}
                isMain={false}
                appName={name}
                docs={answer.alternativeDocs.filter((d) => d.appName === name)}
                selected={selectedIndex === i + 1}
                onSelect={() => onSelect(i + 1)}
                onAskAbout={onAskAbout}
                askedText={askedText}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {answer.elapsedMs ? (
        <p className="sp-meta">
          Пошук зайняв {(answer.elapsedMs / 1000).toFixed(1).replace(".", ",")}{" "}
          с.
        </p>
      ) : null}
    </div>
  );
}
