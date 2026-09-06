import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Check, ChevronDown, Layers3, Sparkles } from "lucide-react";
import Markdown from "./markdown";
import WalkthroughLauncher from "../walkthrough/WalkthroughLauncher";

function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function sameAppName(left, right) {
  return String(left || "").trim().toLocaleLowerCase() ===
    String(right || "").trim().toLocaleLowerCase();
}

function EmptyResult({ answer, invalid }) {
  const { t } = useTranslation();
  return (
    <section className="sp-empty">
      <span className="empty-icon" aria-hidden="true"><Sparkles size={22} /></span>
      <h2>{invalid ? t("result.invalidTitle") : t("result.emptyTitle")}</h2>
      <p>{answer.message || t("result.emptyHint")}</p>
      {answer.contextApps.length > 0 ? (
        <small>{t("result.reviewed", { apps: answer.contextApps.join(", ") })}</small>
      ) : null}
    </section>
  );
}

function UncertainResult({ answer }) {
  const { t } = useTranslation();
  return (
    <section className="sp-empty">
      <span className="empty-icon" aria-hidden="true"><Layers3 size={22} /></span>
      <h2>{t("result.uncertainTitle")}</h2>
      <Markdown className="sp-md" text={answer.message} />
    </section>
  );
}

function GuidePreview({ docs }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const first = docs?.[0];
  if (!first) return null;
  return (
    <section className="result-guide-preview">
      <button type="button" className="result-guide-toggle" onClick={() => setOpen((value) => !value)}>
        <span><BookOpen size={17} /> {t("result.fromGuide", { title: first.title })}</span>
        <ChevronDown size={17} className={open ? "is-open" : ""} />
      </button>
      {open ? (
        <div className="result-guide-body">
          <Markdown className="sp-md" text={first.htmlContent || first.content} isHtml={!!first.htmlContent} />
        </div>
      ) : null}
    </section>
  );
}

function AlternativeCard({ name, docs, selected, onSelect }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (selected && docs.length > 0) setOpen(true);
  }, [docs.length, selected]);

  const toggle = () => {
    onSelect();
    if (docs.length > 0) setOpen((value) => !value);
  };

  return (
    <article className="result-alt-item" data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="result-alt-card"
        data-selected={selected ? "true" : "false"}
        aria-expanded={docs.length > 0 ? open : undefined}
        onClick={toggle}
      >
        <span className="app-monogram" aria-hidden="true">{initials(name)}</span>
        <span className="result-alt-copy">
          <strong>{name}</strong>
          <small>
            {docs.length > 0
              ? t("result.answerGuides", { count: docs.length })
              : t("result.alternative")}
          </small>
        </span>
        <ChevronDown size={17} className={open ? "is-open" : ""} aria-hidden="true" />
      </button>

      {open ? (
        <div className="result-alt-docs">
          {docs.map((doc, index) => (
            <details className="result-alt-doc" key={`${doc.docId || index}-${doc.title}`} open={index === 0}>
              <summary>{doc.title || t("result.guideFallback")}</summary>
              <div className="result-alt-doc-body">
                <Markdown
                  className="sp-md"
                  text={doc.htmlContent || doc.content}
                  isHtml={!!doc.htmlContent}
                />
              </div>
            </details>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export default function ResultView({ answer, selectedIndex, onSelect, askedText = "" }) {
  const { t, i18n } = useTranslation();
  if (!answer) return null;
  if (answer.kind === "empty" || answer.kind === "invalid") {
    return <div className="sp-result"><EmptyResult answer={answer} invalid={answer.kind === "invalid"} /></div>;
  }
  if (answer.kind === "uncertain") {
    return <div className="sp-result"><UncertainResult answer={answer} /></div>;
  }

  const firstDoc = answer.mainDocuments?.[0];

  return (
    <div className="sp-result result-view">
      <header className="result-intro">
        <span className="eyebrow">{t("result.bestMatch")}</span>
        <h2>{t("result.ready", { app: answer.appName })}</h2>
        <p>{t("result.foundLocally")}</p>
      </header>

      <article
        className="result-primary"
        data-selected={selectedIndex === 0 ? "true" : "false"}
        onClick={() => onSelect(0)}
      >
        <div className="result-primary-head">
          <span className="app-monogram is-large" aria-hidden="true">{initials(answer.appName)}</span>
          <div className="result-primary-title">
            <div><h3>{answer.appName}</h3><span className="soft-badge">{t("result.installed")}</span></div>
            <p>{firstDoc?.title || t("result.available")}</p>
          </div>
          <div className="result-actions" onClick={(event) => event.stopPropagation()}>
            <WalkthroughLauncher
              appName={answer.appName}
              docTitle={firstDoc?.title || ""}
              askedText={askedText}
              docId={firstDoc?.docId ?? null}
            />
          </div>
        </div>

        <div className="result-trust-row">
          <span><Check size={15} /> {t("result.installed")}</span>
          <span><Check size={15} /> {t("result.offline")}</span>
          <span><Check size={15} /> {t("result.localKnowledge")}</span>
        </div>
      </article>

      {answer.reason ? (
        <section className="result-reason">
          <span className="eyebrow">{t("result.why")}</span>
          <Markdown className="sp-md" text={answer.reason} />
        </section>
      ) : null}

      <GuidePreview docs={answer.mainDocuments} />

      {answer.alternatives.length > 0 ? (
        <section className="result-alternatives">
          <div className="result-section-title">
            <div><span className="eyebrow">{t("result.otherOptions")}</span><h3>{t("result.alsoFound")}</h3></div>
          </div>
          <div className="result-alt-grid">
            {answer.alternatives.map((name, index) => {
              const docs = answer.alternativeDocs.filter((doc) => sameAppName(doc.appName, name));
              return (
              <AlternativeCard
                key={name}
                name={name}
                docs={docs}
                selected={selectedIndex === index + 1}
                onSelect={() => onSelect(index + 1)}
              />
              );
            })}
          </div>
        </section>
      ) : null}

      {answer.elapsedMs ? (
        <p className="sp-meta">{t("result.elapsed", { value: new Intl.NumberFormat(i18n.language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(answer.elapsedMs / 1000) })}</p>
      ) : null}
    </div>
  );
}
