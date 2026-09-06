/**
 * Кнопка «Показати як» у результаті пошуку і все, що з нею пов'язано.
 *
 * Штатний шлях: кладемо завдання (session.js) і просимо Rust відкрити окреме
 * маленьке вікно поверх усіх (`overlay_show`). Головне вікно при цьому
 * лишається пошуком — воно людині більше не потрібне.
 *
 * Команди `overlay_show` в застосунку може ще не бути. Тоді підказка не зникає:
 * та сама панель показується просто тут, у головному вікні, а над нею — рядок,
 * який пояснює, чому вона не в окремому вікні.
 */
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import WalkthroughPanel from "./WalkthroughPanel";
import { putRequest, clearRequest } from "./session";
import { overlayShow, overlayHide, MissingCommandError } from "./tauri";
import "./walkthrough.css";
import { normalizeLanguage } from "../i18n";

/**
 * Мета сесії: те, що людина спитала. Якщо запит сюди не дійшов —
 * беремо назву знайденої статті, а в найгіршому разі назву програми.
 */
export function buildGoal({ askedText, docTitle, appName, fallback = "" }) {
  const asked = typeof askedText === "string" ? askedText.trim() : "";
  if (asked) return asked;
  const doc = typeof docTitle === "string" ? docTitle.trim() : "";
  if (doc) return doc;
  return appName ? fallback || `Виконати завдання в ${appName}` : "";
}

export default function WalkthroughLauncher({ appName, docTitle, askedText, docId = null }) {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState("idle"); // idle | window | inline
  const [request, setRequest] = useState(null);
  const [reason, setReason] = useState("");

  const open = useCallback(async () => {
    // appId окремим полем бекенд поки не віддає (див. docs/notes/phase5-ui.md),
    // тож ідентифікатором програми служить її назва.
    const next = putRequest({
      appId: appName,
      appName,
      goal: buildGoal({ askedText, docTitle, appName, fallback: t("walkthrough.fallbackGoal", { app: appName }) }),
      docId,
      language: normalizeLanguage(i18n.language) || "en",
    });
    if (!next) return;
    setRequest(next);
    try {
      await overlayShow();
      setReason("");
      setMode("window");
    } catch (error) {
      setReason(
        error instanceof MissingCommandError
          ? t("walkthrough.inlineMissing")
          : t("walkthrough.inlineError"),
      );
      setMode("inline");
    }
  }, [appName, askedText, docId, docTitle, i18n.language, t]);

  const close = useCallback(() => {
    clearRequest();
    setRequest(null);
    setReason("");
    setMode("idle");
    overlayHide().catch(() => {});
  }, []);

  return (
    <div className="wt-launch">
      <div className="row">
        {mode === "inline" ? null : (
          <button type="button" onClick={open}>
            {mode === "window" ? t("walkthrough.showAgain") : t("walkthrough.showHow")}
          </button>
        )}
        {mode !== "idle" ? (
          <button type="button" onClick={close}>
            {t("walkthrough.finishGuide")}
          </button>
        ) : null}
      </div>

      {mode === "idle" ? (
        <p className="wt-launch-note">
          {t("walkthrough.intro")}
        </p>
      ) : null}

      {mode === "window" ? (
        <p className="wt-launch-note">
          {t("walkthrough.windowOpen")}
        </p>
      ) : null}

      {mode === "inline" ? (
        <>
          <p className="wt-launch-note">{reason}</p>
          <WalkthroughPanel request={request} embedded onClose={close} />
        </>
      ) : null}
    </div>
  );
}
