/**
 * Каркас застосунку. Перемикає два режими інтерфейсу і тримає стан з'єднання.
 * Логіки предметної області тут немає — вона в src/user/ та src/dev/.
 * УВАГА: цей файл спільний. Модулі 2.4.1 і 2.4.2 його не змінюють.
 */
import { useEffect, useState } from "react";
import { sidecarStatus, onStatus } from "./ipc";
import Spotlight from "./user/Spotlight";
import DevPanel from "./dev/DevPanel";
import "./ui.css";

export default function App() {
  const [view, setView] = useState("user"); // "user" | "dev"
  const [status, setStatus] = useState(null);

  useEffect(() => {
    sidecarStatus().then(setStatus).catch(() => {});
    const sub = onStatus(setStatus);

    // Cmd+D / Ctrl+D — перемикання між режимом користувача і розробника
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setView((v) => (v === "user" ? "dev" : "user"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      sub.then((un) => un()).catch(() => {});
    };
  }, []);

  return (
    <>
      {view === "user" ? <Spotlight /> : <DevPanel />}
      <footer
        style={{
          position: "fixed", bottom: 0, left: 0, right: 0,
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "4px 10px", borderTop: "1px solid var(--line)",
          background: "var(--panel)", fontSize: 12,
        }}
      >
        <span className="muted">
          <span style={{ color: status?.connected ? "var(--ok)" : "var(--err)" }}>●</span>{" "}
          sidecar {status?.connected ? "підключено" : "немає зв'язку"}
          {status?.mode ? ` · ${status.mode}` : ""}
          {status?.port ? ` · порт ${status.port}` : ""}
        </span>
        <button onClick={() => setView((v) => (v === "user" ? "dev" : "user"))}>
          {view === "user" ? "Розробник (⌘D)" : "Користувач (⌘D)"}
        </button>
      </footer>
    </>
  );
}
