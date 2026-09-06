/**
 * Спільний журнал прогресу: сюди пишуться повідомлення ВСІХ операцій панелі.
 *
 * Журнал живе ПІД смугою вкладок, а не всередині однієї з них: його видно
 * з будь-якого розділу, бо саме заради нього вкладки й перемикають — людина
 * чекає на довгу операцію і мусить бачити, що та жива.
 *
 * Обмеження кількості рядків робить useDevRuntime (важливе воно не зрізає).
 * Тут — лише перегляд того, чого бракувало після нічного прогону:
 * пауза автопрокрутки, фільтр за операцією і копіювання журналу в буфер.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatClock } from "./format";
import { useTranslation } from "react-i18next";
import { dt } from "./i18n";

const LEVEL_CLASS = {
  error: "dp-err",
  done: "dp-ok",
  start: "dp-warn",
  info: "",
  progress: "muted",
};

/** Значення фільтра «усі операції». Порожній рядок був би легальним джерелом. */
const ALL_SOURCES = "*";

/** Рядок журналу як текст — рівно те, що потрапляє в буфер обміну. */
function lineToText(entry) {
  const pct = typeof entry.pct === "number" ? `${entry.pct}% ` : "";
  return `${formatClock(entry.ts)} [${entry.source}] ${pct}${entry.text}`;
}

/**
 * Копіювання в буфер обміну. У вебв'ю Tauri `navigator.clipboard` доступний
 * не завжди, тому лишаємо запасний шлях через приховану textarea — інакше
 * кнопка мовчки не робила б нічого, а це найгірший вид збою.
 */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Дозвіл не дали або API немає — пробуємо запасний шлях нижче.
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export default function ProgressLog({ entries, dropped = 0, onClear }) {
  const { i18n } = useTranslation();
  const bodyRef = useRef(null);

  // Пауза — свідоме рішення людини (кнопка). «Липнення» — те, де стоїть скрол.
  // Автопрокрутка працює, лише коли не на паузі І журнал і так унизу.
  const [paused, setPaused] = useState(false);
  const [stick, setStick] = useState(true);
  const [source, setSource] = useState(ALL_SOURCES);
  const [copied, setCopied] = useState(null);

  const follow = !paused && stick;

  // Список операцій для фільтра — у порядку першої появи в журналі.
  const sources = useMemo(() => {
    const seen = new Set();
    const list = [];
    for (const entry of entries) {
      if (seen.has(entry.source)) continue;
      seen.add(entry.source);
      list.push(entry.source);
    }
    return list;
  }, [entries]);

  // Обрана операція могла зникнути (після «Очистити») — повертаємось до «усі»,
  // інакше журнал виглядав би порожнім без жодного пояснення.
  useEffect(() => {
    if (source !== ALL_SOURCES && !sources.includes(source)) setSource(ALL_SOURCES);
  }, [source, sources]);

  const visible = useMemo(
    () => (source === ALL_SOURCES ? entries : entries.filter((entry) => entry.source === source)),
    [entries, source],
  );

  useEffect(() => {
    const node = bodyRef.current;
    if (!node) return undefined;
    const onScroll = () => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      setStick(distance < 24);
    };
    node.addEventListener("scroll", onScroll);
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (!follow) return;
    const node = bodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [visible, follow]);

  /** Повернутись униз і знову їхати за журналом. */
  const goDown = useCallback(() => {
    setPaused(false);
    setStick(true);
    const node = bodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, []);

  /** Копіюємо саме те, що зараз видно: з фільтром і з чесною позначкою про зрізане. */
  const copy = useCallback(async () => {
    const header = [
      `${dt("log.exportTitle")} · ${new Date().toLocaleString(i18n.language)}`,
      source === ALL_SOURCES ? dt("log.exportAll") : dt("log.exportOne", { source }),
      `${dt("log.exportRows", { count: visible.length })}${dropped > 0 ? ` · ${dt("log.exportClipped", { count: dropped })}` : ""}`,
    ].join("\n");
    const ok = await copyText(`${header}\n${visible.map(lineToText).join("\n")}\n`);
    setCopied(ok ? dt("log.copied") : dt("log.copyFailed"));
  }, [dropped, i18n.language, source, visible]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(null), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="dp-log">
      <div className="dp-log-head">
        <span className="dp-section-title">{dt("log.title")}</span>

        <span className="dp-log-tools">
          <span className="dp-badge" title={dt("log.rows")}>
            {source === ALL_SOURCES ? entries.length : dt("log.shown", { shown: visible.length, total: entries.length })}
          </span>

          {dropped > 0 ? (
            <span
              className="dp-badge"
              title={dt("log.clippedHint")}
            >
              {dt("log.clipped", { count: dropped })}
            </span>
          ) : null}

          <select
            className="dp-log-filter"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            title={dt("log.filter")}
            aria-label={dt("log.filter")}
          >
            <option value={ALL_SOURCES}>{dt("log.all")}</option>
            {sources.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => setPaused((value) => !value)}
            title={paused ? dt("log.pauseHint") : dt("log.autoHint")}
          >
            {paused ? dt("log.pause") : dt("log.auto")}
          </button>

          {!follow ? (
            <button type="button" onClick={goDown}>
              {dt("log.down")}
            </button>
          ) : null}

          <button type="button" onClick={copy} disabled={visible.length === 0}>
            {dt("log.copy")}
          </button>

          <button type="button" onClick={onClear} disabled={entries.length === 0}>
            {dt("log.clear")}
          </button>

          {copied ? <span className="dp-small muted">{copied}</span> : null}
        </span>
      </div>

      <div className="dp-log-body" ref={bodyRef}>
        {entries.length === 0 ? (
          <div className="muted">{dt("log.empty")}</div>
        ) : visible.length === 0 ? (
          <div className="muted">{dt("log.emptySource", { source })}</div>
        ) : (
          visible.map((entry) => (
            <div className="dp-log-line" key={entry.seq}>
              <span className="dp-log-time">{formatClock(entry.ts)}</span>
              <span className="dp-log-src">[{entry.source}]</span>
              <span className={LEVEL_CLASS[entry.level] || ""}>
                {typeof entry.pct === "number" ? `${entry.pct}% ` : ""}
                {entry.text}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
