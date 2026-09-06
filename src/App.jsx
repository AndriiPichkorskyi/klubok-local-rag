/**
 * Головна оболонка Klubok: постійна навігація та перемикання робочих екранів.
 * Предметна логіка лишається у відповідних модулях, оболонка тримає тільки UI-стан.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  ChevronRight,
  Grid2X2,
  MessageCircleMore,
  SquareTerminal,
} from "lucide-react";
import { sidecarStatus, onStatus } from "./ipc";
import Spotlight from "./user/Spotlight";
import InstalledApps from "./user/InstalledApps";
import Guides from "./user/Guides";
import DevPanel from "./dev/DevPanel";
import klubokImage from "./assets/klubok_transparent.png";
import { normalizeLanguage, setLanguage } from "./i18n";
import "./ui.css";

const NAV_ITEMS = [
  { id: "ask", labelKey: "shell.ask", icon: MessageCircleMore },
  { id: "apps", labelKey: "shell.apps", icon: Grid2X2 },
  { id: "guides", labelKey: "shell.guides", icon: BookOpen },
  { id: "dev", labelKey: "shell.dev", icon: SquareTerminal },
];

export default function App() {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState("ask");
  const [status, setStatus] = useState(null);
  const [guideFilter, setGuideFilter] = useState(null);

  useEffect(() => {
    sidecarStatus()
      .then(setStatus)
      .catch(() => {});
    const sub = onStatus(setStatus);

    // Cmd+D / Ctrl+D — швидкий перехід між Ask Klubok і режимом розробника.
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        setView((current) => (current === "dev" ? "ask" : "dev"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      sub.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  const openGuidesForApp = (app) => {
    setGuideFilter(app ? { id: app.id, name: app.name } : null);
    setView("guides");
  };

  return (
    <div className="app-shell">
      <aside className="app-sidebar" aria-label={t("shell.navigation")}>
        <div className="app-brand" aria-label="Klubok">
          <span className="app-brand-mark" aria-hidden="true">
            <img src={klubokImage} alt="" />
          </span>
          <span>Klubok</span>
        </div>

        <nav className="app-nav">
          {NAV_ITEMS.map(({ id, labelKey, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className="app-nav-item"
              data-active={view === id ? "true" : "false"}
              aria-current={view === id ? "page" : undefined}
              onClick={() => {
                if (id === "guides" && view !== "guides") setGuideFilter(null);
                setView(id);
              }}
            >
              <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
              <span>{t(labelKey)}</span>
            </button>
          ))}
        </nav>

        <div className="app-sidebar-status">
          <div
            className="language-switcher"
            role="group"
            aria-label={t("shell.language")}
          >
            <button
              type="button"
              data-active={
                normalizeLanguage(i18n.language) === "uk" ? "true" : "false"
              }
              aria-pressed={normalizeLanguage(i18n.language) === "uk"}
              onClick={() => setLanguage("uk")}
            >
              {t("shell.ukrainian")}
            </button>
            <button
              type="button"
              data-active={
                normalizeLanguage(i18n.language) === "en" ? "true" : "false"
              }
              aria-pressed={normalizeLanguage(i18n.language) === "en"}
              onClick={() => setLanguage("en")}
            >
              {t("shell.english")}
            </button>
          </div>
          <div className="app-status-line">
            <span
              className={
                status?.connected
                  ? "app-status-dot is-online"
                  : "app-status-dot"
              }
              aria-hidden="true"
            />
            <div>
              <strong>
                {status?.connected
                  ? t("shell.localActive")
                  : t("shell.offline")}
              </strong>
              <span>
                {status?.connected
                  ? t("shell.localOnly")
                  : t("shell.checkConnection")}
              </span>
            </div>
            {/* <ChevronRight size={16} aria-hidden="true" /> */}
          </div>
        </div>
      </aside>

      <div className="app-workspace">
        {view === "ask" ? <Spotlight /> : null}
        {view === "apps" ? (
          <InstalledApps onOpenGuides={openGuidesForApp} />
        ) : null}
        {view === "guides" ? (
          <Guides
            appFilter={guideFilter}
            onClearFilter={() => setGuideFilter(null)}
          />
        ) : null}
        {view === "dev" ? <DevPanel /> : null}
      </div>
    </div>
  );
}
