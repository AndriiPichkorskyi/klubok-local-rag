/**
 * Режим розробника: сире, чим живе крок.
 *
 * Це інструмент налагодження, а не вітрина, тому: щільно, моноширинним, за
 * замовчуванням згорнуто, усе можна виділити й скопіювати. Нічого не
 * прикрашаємо і нічого не домальовуємо — поля, якого бекенд не прислав, у
 * панелі немає, і замість нього стоїть чесний рядок про це.
 *
 * Блок діагностики дає бекенд під `config.walkthrough.debug`. Коли блока немає,
 * панель не порожніє: лишається все, що вікно знає саме (кадр, активація,
 * frontmost, час виклику), плюс рядок, що діагностику вимкнено в конфізі.
 */
import { useMemo, useState } from "react";
import {
  entryRows,
  entryJson,
  historyJson,
  pick,
  formatDropped,
  formatMs,
} from "./diagnostics";

/** Копіювання без залежностей. Вікно підказки не бере фокус, тож може й не
 *  вийти — тоді кажемо про це прямо, а текст лишається виділюваним у <pre>. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* буфера немає або вікно без фокуса — пробуємо старий спосіб */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Кнопка «Копіювати» з коротким підтвердженням замість мовчання. */
function CopyButton({ text, label, className = "wt-dbg-copy" }) {
  const [said, setSaid] = useState("");
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        const ok = await copyText(text);
        setSaid(ok ? "скопійовано" : "не вдалося");
        setTimeout(() => setSaid(""), 1500);
      }}
    >
      {said || label}
    </button>
  );
}

/** Довгий сирий текст: моноширинний, прокручується, виділяється. */
function RawBlock({ title, value, empty }) {
  const text =
    typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2);
  return (
    <div className="wt-dbg-block">
      <div className="wt-dbg-block-head">
        <span className="wt-dbg-block-title">{title}</span>
        {text ? <CopyButton text={text} label="копіювати" /> : null}
      </div>
      {text ? (
        <pre className="wt-dbg-pre">{text}</pre>
      ) : (
        <p className="wt-dbg-empty">{empty}</p>
      )}
    </div>
  );
}

export default function DebugPanel({ history = [], config = {}, request = null, asked = false }) {
  const [pickedId, setPickedId] = useState(null);

  const entry = useMemo(() => {
    if (!history.length) return null;
    return history.find((item) => item.id === pickedId) || history[history.length - 1];
  }, [history, pickedId]);

  const block = entry?.debug || null;
  const rows = useMemo(() => entryRows(entry), [entry]);

  return (
    <section className="wt-dbg" aria-label="Сирі дані кроку">
      <div className="wt-dbg-top">
        <span className="wt-dbg-title">Сире</span>
        <span className="wt-dbg-count">
          {history.length} {history.length === 1 ? "крок" : "кроків"}
        </span>
        {history.length ? (
          <CopyButton text={historyJson(history)} label="сесія → JSON" />
        ) : null}
        {entry ? <CopyButton text={entryJson(entry)} label="крок → JSON" /> : null}
      </div>

      {!block ? (
        <p className="wt-dbg-note">
          {asked
            ? "Блока діагностики в цьому кроці немає. Поки перемикач увімкнено, вікно просить його в кожному кроці (debug: true) — зробіть наступний крок, і сире з'явиться. Постійно діагностику вмикає walkthrough.debug у конфізі. Нижче — те, що вікно знає саме."
            : "Діагностику вимкнено в конфізі (walkthrough.debug). Промпт і сира відповідь моделі приходять лише з нею; нижче — те, що вікно знає саме."}
        </p>
      ) : null}

      {!entry ? (
        <p className="wt-dbg-empty">Кроків ще не було: сирим даним нема звідки взятись.</p>
      ) : (
        <>
          <dl className="wt-dbg-rows">
            {rows.map(([name, value]) => (
              <div className="wt-dbg-row" key={name}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>

          <RawBlock
            title="Відповідь моделі до розбору"
            value={pick(block, "raw")}
            empty="Бекенд не прислав сирої відповіді."
          />
          <RawBlock
            title="Промпт, який пішов у модель"
            value={pick(block, "prompt")}
            empty="Бекенд не прислав промпта."
          />
          <RawBlock
            title="Відкинула санітарія"
            value={formatDropped(block)}
            empty="Нічого не відкинуто (або бекенд про це не звітує)."
          />
          <RawBlock
            title="Крок, як його прислав бекенд"
            value={entry.step}
            empty="Кроку немає: виклик завершився помилкою."
          />
          {block ? (
            <RawBlock title="Блок діагностики цілком" value={block} empty="" />
          ) : null}
        </>
      )}

      {history.length > 1 ? (
        <div className="wt-dbg-block">
          <div className="wt-dbg-block-head">
            <span className="wt-dbg-block-title">Історія сесії</span>
          </div>
          <ul className="wt-dbg-history">
            {history.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="wt-dbg-hrow"
                  aria-current={item.id === entry?.id ? "true" : undefined}
                  onClick={() => setPickedId(item.id)}
                >
                  <span className="wt-dbg-hn">#{item.id}</span>
                  <span className="wt-dbg-hstate">
                    {item.error ? "помилка" : item.step?.state || "—"}
                  </span>
                  <span className="wt-dbg-hmeta">{item.method.replace("walkthrough.", "")}</span>
                  <span className="wt-dbg-hmeta">{formatMs(item.clientMs)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="wt-dbg-note">
        Сесія: {request?.appId || "?"}
        {request?.goal ? ` · мета «${request.goal}»` : ""} · пауза після активації{" "}
        {config.activationDelayMs ?? "?"} мс · режим кроків {config.stepSource || "?"}
      </p>
    </section>
  );
}
