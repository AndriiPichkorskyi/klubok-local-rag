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
import WalkthroughPanel from "./WalkthroughPanel";
import { putRequest, clearRequest } from "./session";
import { overlayShow, overlayHide, MissingCommandError } from "./tauri";
import "./walkthrough.css";

/**
 * Мета сесії: те, що людина спитала. Якщо запит сюди не дійшов —
 * беремо назву знайденої статті, а в найгіршому разі назву програми.
 */
export function buildGoal({ askedText, docTitle, appName }) {
  const asked = typeof askedText === "string" ? askedText.trim() : "";
  if (asked) return asked;
  const doc = typeof docTitle === "string" ? docTitle.trim() : "";
  if (doc) return doc;
  return appName ? `Виконати завдання в ${appName}` : "";
}

export default function WalkthroughLauncher({ appName, docTitle, askedText, docId = null }) {
  const [mode, setMode] = useState("idle"); // idle | window | inline
  const [request, setRequest] = useState(null);
  const [reason, setReason] = useState("");

  const open = useCallback(async () => {
    // appId окремим полем бекенд поки не віддає (див. docs/notes/phase5-ui.md),
    // тож ідентифікатором програми служить її назва.
    const next = putRequest({
      appId: appName,
      appName,
      goal: buildGoal({ askedText, docTitle, appName }),
      docId,
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
          ? "Окреме вікно поверх усіх ще не працює: у застосунку немає команди «overlay_show». " +
            "Показуємо підказку тут."
          : `Окреме вікно не відкрилося (${String(error?.message ?? error)}). Показуємо підказку тут.`,
      );
      setMode("inline");
    }
  }, [appName, askedText, docId, docTitle]);

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
            {mode === "window" ? "Показати вікно підказки ще раз" : "Показати як"}
          </button>
        )}
        {mode !== "idle" ? (
          <button type="button" onClick={close}>
            Завершити підказку
          </button>
        ) : null}
      </div>

      {mode === "idle" ? (
        <p className="wt-launch-note">
          Проведемо по інтерфейсі програми крок за кроком: підказка стане маленьким вікном
          у кутку екрана, а ви працюватимете у самій програмі.
        </p>
      ) : null}

      {mode === "window" ? (
        <p className="wt-launch-note">
          Підказку відкрито окремим вікном поверх інших. Це вікно можна лишити позаду.
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
