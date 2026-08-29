/**
 * Модуль 2.4.2 — панель розробника.
 * Порт термінального меню sidecar/src/cli/index.js у React: склад пунктів той самий,
 * змінена лише подача. Усі виклики бекенда йдуть виключно через src/ipc.js.
 *
 * Головна вимога: інтерфейс не блокується ніколи. Довгі методи (векторизація,
 * тести) стартують у useDevRuntime і живуть у стані; поки вони йдуть, решта
 * панелі повністю робоча, а прогрес видно у спільному журналі праворуч.
 *
 * Секцій стало забагато для одного списку, тому вони розкладені по вкладках.
 * Дві речі тут принципові:
 *   1) журнал прогресу стоїть ПІД смугою вкладок, а не всередині однієї з них —
 *      його видно завжди, з будь-якого розділу;
 *   2) приховані вкладки НЕ розмонтовуються (лише `hidden`), тож операція,
 *      запущена в одному розділі, живе далі, а стан секції — прапорці прогону,
 *      обраний звіт, завантажена статистика — не губиться при переході.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDevRuntime } from "./useDevRuntime";
import DevTabs from "./DevTabs";
import ProgressLog from "./ProgressLog";
import SidecarSection from "./SidecarSection";
import PipelineSection from "./PipelineSection";
import FullRunSection from "./FullRunSection";
import StatsSection from "./StatsSection";
import ClearSection from "./ClearSection";
import TestsSection from "./TestsSection";
import ReportsSection from "./ReportsSection";
import ConfigSection from "./ConfigSection";
import "./dev.css";

/** Резерв на випадок, якщо конфіг ще не приїхав або в ньому немає списку моделей. */
const FALLBACK_EMBED_MODELS = ["qwen3-embedding:0.6b", "qwen3-embedding:4b"];

/**
 * Вкладки згруповані за причиною, з якої панель відкривають, а не за технічним
 * поділом на методи RPC:
 *   «Прогін»         — те, що роблять щодня: повний прогін і окремі кроки пайплайна;
 *   «Результати»     — те, заради чого прогін і робився: статистика, тести, звіти;
 *   «Обслуговування» — рідкісне й незворотне (очистка бази) — навмисно осторонь,
 *                      щоб не потрапити туди випадково під час щоденної роботи;
 *   «Оточення»       — службове, яке відкривають, коли щось не працює: sidecar і конфіг.
 *
 * `owns` каже, які ключі операцій належать вкладці — з цього рахується позначка
 * «тут щось виконується». Ключі перелічені там, де вони й задаються (секції),
 * тож звіряти треба саме з ними.
 */
const TABS = [
  {
    id: "run",
    label: "Прогін",
    hint: "щоденне: повний прогін і окремі кроки пайплайна",
    owns: (key) => key.startsWith("pipeline.") || key.startsWith("full:"),
  },
  {
    id: "results",
    label: "Результати",
    hint: "що вийшло: статистика бази, тести і їхні звіти",
    owns: (key) => key === "db.stats" || key.startsWith("tests.") || key.startsWith("reports."),
  },
  {
    id: "maintenance",
    label: "Обслуговування",
    hint: "рідкісні незворотні дії: очистка бази",
    owns: (key) => key.startsWith("db.clear:"),
  },
  {
    id: "env",
    label: "Оточення",
    hint: "службове: sidecar, перевірка оточення, конфіг",
    owns: (key) =>
      key === "ping" ||
      key === "sidecarRestart" ||
      key === "bootstrap.check" ||
      key.startsWith("config."),
  },
];

const TAB_STORAGE_KEY = "devPanel.activeTab";

/**
 * Вкладка з минулого разу. Vite HMR перезавантажує вікно часто, і щоразу
 * повертатись на першу вкладку — зайве роздратування. localStorage може бути
 * недоступним (приватний режим), тому читаємо захищено.
 */
function readStoredTab() {
  try {
    const stored = window.localStorage.getItem(TAB_STORAGE_KEY);
    if (TABS.some((tab) => tab.id === stored)) return stored;
  } catch {
    // Сховище недоступне — просто починаємо з першої вкладки.
  }
  return TABS[0].id;
}

/** Моделі ембедингу з конфіга: required + optional, лише embedding-моделі. */
function embedModelsOf(config) {
  const declared = [
    ...(config?.bootstrap?.requiredModels || []),
    ...(config?.bootstrap?.optionalModels || []),
  ].filter((model) => model.includes("embedding"));

  const list = declared.length > 0 ? declared : FALLBACK_EMBED_MODELS;
  const current = config?.embedModelName;
  return current && !list.includes(current) ? [current, ...list] : list;
}

export default function DevPanel() {
  const {
    ops,
    run,
    cancelOp,
    note,
    anyRunning,
    runningCount,
    logEntries,
    logDropped,
    clearLog,
  } = useDevRuntime();
  const [reportsRefresh, setReportsRefresh] = useState(0);
  const [statsRefresh, setStatsRefresh] = useState(0);
  const [activeTab, setActiveTab] = useState(readStoredTab);

  // Колонка секцій прокручується спільно для всіх вкладок, тому положення
  // скролу запам'ятовуємо окремо для кожної: інакше повернення на вкладку
  // з довгим прогоном викидало б у випадкове місце.
  const colRef = useRef(null);
  const scrollByTabRef = useRef({});

  const selectTab = useCallback(
    (id) => {
      if (id === activeTab) return;
      if (colRef.current) scrollByTabRef.current[activeTab] = colRef.current.scrollTop;
      setActiveTab(id);
    },
    [activeTab],
  );

  useLayoutEffect(() => {
    const node = colRef.current;
    if (node) node.scrollTop = scrollByTabRef.current[activeTab] || 0;
  }, [activeTab]);

  useEffect(() => {
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, activeTab);
    } catch {
      // Сховище недоступне — вкладка просто не переживе перезавантаження.
    }
  }, [activeTab]);

  // Скільки операцій виконується на кожній вкладці. Саме це показує крапку
  // на вкладці, з якої пішли, не дочекавшись кінця.
  const runningCounts = useMemo(() => {
    const counts = {};
    for (const [key, op] of Object.entries(ops)) {
      if (!op?.running) continue;
      const tab = TABS.find((item) => item.owns(key));
      if (tab) counts[tab.id] = (counts[tab.id] || 0) + 1;
    }
    return counts;
  }, [ops]);

  // Актуальний конфіг — те, що повернув останній із config.get / config.reload.
  const config = useMemo(() => {
    const get = ops["config.get"];
    const reload = ops["config.reload"];
    const newest =
      (reload?.finishedAt || 0) > (get?.finishedAt || 0) ? reload : get;
    return newest?.result && typeof newest.result === "object" ? newest.result : null;
  }, [ops]);

  const embedModels = useMemo(() => embedModelsOf(config), [config]);
  const onTestsFinished = useCallback(() => setReportsRefresh((value) => value + 1), []);

  // Після повного прогону оновлюємо і список звітів, і статистику: саме там
  // видно, чи справді векторизувалась кожна модель.
  const onFullRunFinished = useCallback(() => {
    setReportsRefresh((value) => value + 1);
    setStatsRefresh((value) => value + 1);
  }, []);

  /** Обгортка вкладки. `hidden` замість розмонтування — див. шапку файлу. */
  const pane = (id, children) => (
    <div
      className="dp-pane"
      id={`dp-pane-${id}`}
      role="tabpanel"
      aria-labelledby={`dp-tab-${id}`}
      hidden={activeTab !== id}
    >
      {children}
    </div>
  );

  return (
    <main className="dp-root">
      <header className="dp-head">
        <span className="dp-title">Панель розробника</span>
        <span className="row dp-small muted">
          {anyRunning ? (
            <span className="dp-warn">виконується операцій: {runningCount}</span>
          ) : (
            <span>операцій не виконується</span>
          )}
          <span className="dp-badge">⌘D — режим користувача</span>
        </span>
      </header>

      <DevTabs tabs={TABS} active={activeTab} onSelect={selectTab} runningCounts={runningCounts} />

      <div className="dp-body">
        <div className="dp-col" ref={colRef}>
          {pane(
            "run",
            <>
              <FullRunSection
                ops={ops}
                run={run}
                cancelOp={cancelOp}
                note={note}
                embedModels={embedModels}
                configModel={config?.embedModelName || null}
                onFinished={onFullRunFinished}
              />
              <PipelineSection ops={ops} run={run} cancelOp={cancelOp} embedModels={embedModels} />
            </>,
          )}

          {pane(
            "results",
            <>
              <StatsSection ops={ops} run={run} cancelOp={cancelOp} refreshKey={statsRefresh} />
              <TestsSection ops={ops} run={run} cancelOp={cancelOp} onFinished={onTestsFinished} />
              <ReportsSection ops={ops} run={run} cancelOp={cancelOp} refreshKey={reportsRefresh} />
            </>,
          )}

          {pane("maintenance", <ClearSection ops={ops} run={run} cancelOp={cancelOp} />)}

          {pane(
            "env",
            <>
              <SidecarSection ops={ops} run={run} cancelOp={cancelOp} note={note} />
              <ConfigSection ops={ops} run={run} cancelOp={cancelOp} config={config} />
            </>,
          )}
        </div>

        <div className="dp-col" style={{ overflowY: "hidden" }}>
          <ProgressLog entries={logEntries} dropped={logDropped} onClear={clearLog} />
        </div>
      </div>
    </main>
  );
}
