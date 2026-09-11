import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, ChevronRight, RefreshCw, Search, X } from "lucide-react";
import { catalogGuide, catalogGuides } from "../ipc";
import WalkthroughLauncher from "../walkthrough/WalkthroughLauncher";
import Markdown from "./markdown";

/** Скільки довідок тягнемо за один запит. Бекенд обмежує сторінку 200 записами. */
const PAGE_SIZE = 120;

export default function Guides({ appFilter, onClearFilter }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [data, setData] = useState({ items: [], total: 0 });
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [state, setState] = useState("loading");
  const [detailState, setDetailState] = useState("idle");
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      setState("loading");
      setError("");
      catalogGuides({
        search: search.trim(),
        appId: appFilter?.id || null,
        limit: PAGE_SIZE,
        offset: 0,
      })
        .then((result) => {
          if (!current) return;
          const next = result && Array.isArray(result.items) ? result : { items: [], total: 0 };
          setData(next);
          setSelectedId((id) =>
            next.items.some((item) => item.id === id) ? id : next.items[0]?.id || null,
          );
          setState("ready");
        })
        .catch((caught) => {
          if (!current) return;
          setError(String(caught?.message || caught));
          setState("error");
        });
    }, 180);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [appFilter?.id, reloadKey, search]);

  const loadMore = () => {
    if (loadingMore || data.items.length >= data.total) return;
    setLoadingMore(true);
    catalogGuides({
      search: search.trim(),
      appId: appFilter?.id || null,
      limit: PAGE_SIZE,
      offset: data.items.length,
    })
      .then((result) => {
        const items = result && Array.isArray(result.items) ? result.items : [];
        setData((previous) => {
          const known = new Set(previous.items.map((item) => item.id));
          return {
            items: [...previous.items, ...items.filter((item) => !known.has(item.id))],
            total: Number.isFinite(result?.total) ? result.total : previous.total,
          };
        });
      })
      .catch((caught) => setError(String(caught?.message || caught)))
      .finally(() => setLoadingMore(false));
  };

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailState("idle");
      return undefined;
    }
    let current = true;
    setDetailState("loading");
    catalogGuide(selectedId)
      .then((guide) => {
        if (!current) return;
        setDetail(guide);
        setDetailState("ready");
      })
      .catch((caught) => {
        if (!current) return;
        setDetail({ error: String(caught?.message || caught) });
        setDetailState("error");
      });
    return () => {
      current = false;
    };
  }, [selectedId]);

  const selectedSummary = useMemo(
    () => data.items.find((item) => item.id === selectedId) || null,
    [data.items, selectedId],
  );

  return (
    <main className="catalog-page guides-page">
      <header className="catalog-header">
        <div>
          <span className="eyebrow">{t("guides.eyebrow")}</span>
          <h1>{t("guides.title")}</h1>
          <p>{t("guides.subtitle")}</p>
        </div>
        <div className="catalog-count">{t("guides.count", { count: data.total })}</div>
      </header>

      <div className="guide-toolbar">
        <label className="catalog-search">
          <Search size={18} aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("guides.placeholder")}
            aria-label={t("guides.search")}
          />
        </label>
        {appFilter ? (
          <button type="button" className="filter-chip" onClick={onClearFilter}>
            {appFilter.name} <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {state === "error" ? (
        <section className="catalog-state" role="alert">
          <h2>{t("guides.readError")}</h2>
          {error ? <details><summary>{t("common.technicalDetails")}</summary><p>{error}</p></details> : null}
          <button type="button" onClick={() => setReloadKey((value) => value + 1)}>
            <RefreshCw size={16} /> {t("common.retry")}
          </button>
        </section>
      ) : null}

      {state !== "error" ? (
        <div className="catalog-layout guide-layout">
          <section className="catalog-list guide-list" aria-label={t("guides.listLabel")}>
            {state === "loading" && data.items.length === 0 ? (
              <div className="catalog-loading">{t("guides.loading")}</div>
            ) : null}
            {state === "ready" && data.items.length === 0 ? (
              <div className="catalog-empty">{t("guides.empty")}</div>
            ) : null}
            {data.items.map((guide) => (
              <button
                key={guide.id}
                type="button"
                className="guide-row"
                data-selected={selectedId === guide.id ? "true" : "false"}
                onClick={() => setSelectedId(guide.id)}
              >
                <span className="guide-row-icon" aria-hidden="true"><BookOpen size={18} /></span>
                <span className="guide-row-copy">
                  <span>{guide.appName}</span>
                  <strong>{guide.title}</strong>
                  <small>{guide.excerpt || t("guides.saved")}</small>
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            ))}
            {state !== "loading" && data.items.length < data.total ? (
              <div className="catalog-more">
                <span>{t("guides.shown", { count: data.items.length, total: data.total })}</span>
                <button type="button" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? t("guides.loading") : t("guides.showMore", { count: Math.min(PAGE_SIZE, data.total - data.items.length) })}
                </button>
              </div>
            ) : null}
          </section>

          <article className="catalog-detail guide-detail" aria-live="polite">
            {detailState === "loading" ? (
              <div className="catalog-loading">{t("guides.opening")}</div>
            ) : null}
            {detailState === "error" ? (
              <div className="catalog-empty">
                <p>{t("guides.openError")}</p>
                {detail?.error ? <details><summary>{t("common.technicalDetails")}</summary><p>{detail.error}</p></details> : null}
              </div>
            ) : null}
            {detailState === "ready" && detail ? (
              <>
                <header className="guide-detail-head">
                  <div>
                    <span className="eyebrow">{detail.appName} · {detail.sourceType}</span>
                    <h2>{detail.title}</h2>
                  </div>
                  <span className="soft-badge">{t("guides.offline")}</span>
                </header>
                <div className="guide-content">
                  <Markdown className="sp-md" text={detail.content} />
                </div>
                <footer className="guide-actions">
                  <WalkthroughLauncher
                    appName={detail.appName}
                    docTitle={detail.title}
                    docId={detail.documentId}
                  />
                </footer>
              </>
            ) : null}
            {detailState === "idle" && !selectedSummary ? (
              <div className="catalog-empty">{t("guides.select")}</div>
            ) : null}
          </article>
        </div>
      ) : null}
    </main>
  );
}
