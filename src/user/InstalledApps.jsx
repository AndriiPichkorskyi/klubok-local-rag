import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  FolderOpen,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { catalogApps } from "../ipc";
import { launchApp } from "../walkthrough/tauri";

function appKind(path, t) {
  if (String(path || "").startsWith("/System/")) return t("catalog.builtIn");
  if (String(path || "").startsWith("/Applications/")) return t("catalog.installedApp");
  return t("catalog.localTool");
}

function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function keywordList(value) {
  return String(value || "")
    .split(/[,;\n]/)
    .map((item) => item.trim().replace(/^[-•]\s*/, ""))
    .filter((item) => item.length > 1)
    .slice(0, 6);
}

export default function InstalledApps({ onOpenGuides }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [data, setData] = useState({ items: [], total: 0 });
  const [selectedId, setSelectedId] = useState(null);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [launchError, setLaunchError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      setState("loading");
      setError("");
      catalogApps({ search: search.trim(), limit: 200 })
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
  }, [search, reloadKey]);

  const selected = useMemo(
    () => data.items.find((item) => item.id === selectedId) || null,
    [data.items, selectedId],
  );
  const capabilities = keywordList(selected?.keywords);
  const knownCapabilities = capabilities.length > 0
    ? capabilities
    : Array.isArray(selected?.guideTitles)
      ? selected.guideTitles
      : [];

  const openSelected = async () => {
    if (!selected) return;
    setLaunchError("");
    try {
      await launchApp(selected.path || selected.id);
    } catch (caught) {
      setLaunchError(String(caught?.message || caught));
    }
  };

  return (
    <main className="catalog-page">
      <header className="catalog-header">
        <div>
          <span className="eyebrow">{t("catalog.eyebrow")}</span>
          <h1>{t("catalog.title")}</h1>
          <p>{t("catalog.subtitle")}</p>
        </div>
        <div className="catalog-count">{t("catalog.count", { count: data.total })}</div>
      </header>

      <label className="catalog-search">
        <Search size={18} aria-hidden="true" />
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("catalog.placeholder")}
          aria-label={t("catalog.search")}
        />
      </label>

      {state === "error" ? (
        <section className="catalog-state" role="alert">
          <h2>{t("catalog.readError")}</h2>
          {error ? <details><summary>{t("common.technicalDetails")}</summary><p>{error}</p></details> : null}
          <button type="button" onClick={() => setReloadKey((value) => value + 1)}>
            <RefreshCw size={16} /> {t("common.retry")}
          </button>
        </section>
      ) : null}

      {state !== "error" ? (
        <div className="catalog-layout">
          <section className="catalog-list" aria-label={t("catalog.listLabel")}>
            {state === "loading" && data.items.length === 0 ? (
              <div className="catalog-loading">{t("catalog.loading")}</div>
            ) : null}
            {state === "ready" && data.items.length === 0 ? (
              <div className="catalog-empty">{t("catalog.empty")}</div>
            ) : null}
            {data.items.map((app) => (
              <button
                key={app.id}
                type="button"
                className="catalog-row"
                data-selected={selectedId === app.id ? "true" : "false"}
                onClick={() => setSelectedId(app.id)}
              >
                <span className="app-monogram" aria-hidden="true">{initials(app.name)}</span>
                <span className="catalog-row-copy">
                  <strong>{app.name}</strong>
                  <span>{appKind(app.path, t)}</span>
                </span>
                <span className="catalog-row-meta">
                  {app.availableGuidesCount ? t("catalog.guides", { count: app.availableGuidesCount }) : t("catalog.noGuides")}
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            ))}
          </section>

          <section className="catalog-detail" aria-live="polite">
            {selected ? (
              <>
                <div className="catalog-detail-head">
                  <span className="app-monogram is-large" aria-hidden="true">
                    {initials(selected.name)}
                  </span>
                  <div>
                    <div className="catalog-title-line">
                      <h2>{selected.name}</h2>
                      <span className="soft-badge">{appKind(selected.path, t)}</span>
                    </div>
                    <p>{selected.version ? t("catalog.version", { version: selected.version }) : t("catalog.versionUnavailable")}</p>
                  </div>
                  <button type="button" className="btn-primary catalog-open" onClick={openSelected}>
                    <ArrowUpRight size={16} /> {t("catalog.openApp")}
                  </button>
                </div>

                <div className="catalog-trust-row">
                  <span><ShieldCheck size={16} /> {t("catalog.installedLocally")}</span>
                  <span><FolderOpen size={16} /> {t("catalog.worksHere")}</span>
                  <span><BookOpen size={16} /> {t("catalog.guidesReady", { count: selected.availableGuidesCount })}</span>
                </div>

                <div className="catalog-section">
                  <span className="eyebrow">{t("catalog.capabilitiesEyebrow")}</span>
                  <h3>{t("catalog.capabilities")}</h3>
                  {knownCapabilities.length > 0 ? (
                    <div className="capability-grid">
                      {knownCapabilities.map((capability) => (
                        <div className="capability-card" key={capability}>{capability}</div>
                      ))}
                    </div>
                  ) : (
                    <p className="catalog-muted">
                      {selected.availableGuidesCount > 0
                        ? t("catalog.localGuides", { count: selected.availableGuidesCount })
                        : t("catalog.noLoadedGuides")}
                    </p>
                  )}
                </div>

                <div className="catalog-detail-footer">
                  <div>
                    <span className="eyebrow">{t("catalog.location")}</span>
                    <code>{selected.path}</code>
                  </div>
                  <button
                    type="button"
                    disabled={selected.availableGuidesCount === 0}
                    onClick={() => onOpenGuides(selected)}
                  >
                    <BookOpen size={16} /> {t("catalog.showGuides")}
                  </button>
                </div>
                {launchError ? (
                  <div className="catalog-inline-error">
                    <p>{t("catalog.openError")}</p>
                    <details><summary>{t("common.technicalDetails")}</summary><p>{launchError}</p></details>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="catalog-empty">{t("catalog.select")}</div>
            )}
          </section>
        </div>
      ) : null}
    </main>
  );
}
