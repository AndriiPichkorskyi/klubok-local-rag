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
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { dt } from "./i18n";
import { useDevRuntime } from "./useDevRuntime";
import { useBenchmarkAxes } from "./useBenchmarkAxes";
import { Splitter, useSplitter } from "./Splitter";
import DevTabs from "./DevTabs";
import ProgressLog from "./ProgressLog";
import SidecarSection from "./SidecarSection";
import PipelineSection from "./PipelineSection";
import FullRunSection from "./FullRunSection";
import StatsSection from "./StatsSection";
import ClearSection from "./ClearSection";
import ReportsSection from "./ReportsSection";
import ConfigSection from "./ConfigSection";
import "./dev.css";

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
    labelKey: "tabs.run",
    hintKey: "tabs.runHint",
    owns: (key) => key.startsWith("pipeline.") || key.startsWith("full:"),
  },
  {
    id: "results",
    labelKey: "tabs.results",
    hintKey: "tabs.resultsHint",
    owns: (key) => key === "db.stats" || key.startsWith("tests.") || key.startsWith("reports."),
  },
  {
    id: "maintenance",
    labelKey: "tabs.maintenance",
    hintKey: "tabs.maintenanceHint",
    owns: (key) => key.startsWith("db.clear:"),
  },
  {
    id: "env",
    labelKey: "tabs.env",
    hintKey: "tabs.envHint",
    owns: (key) =>
      key === "ping" ||
      key === "sidecarRestart" ||
      key.startsWith("bootstrap.") ||
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

/** Моделі ембедингу з єдиного конфіга. */
function embedModelsOf(config) {
  const list = [...new Set(config?.embedModels || [])];
  const current = config?.embedModelName;
  return current && !list.includes(current) ? [current, ...list] : list;
}

export default function DevPanel() {
  const { i18n } = useTranslation();
  const {
    ops,
    run,
    cancelOp,
    pauseOp,
    resumeOp,
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
  const translatedTabs = useMemo(
    () => TABS.map((tab) => ({ ...tab, label: dt(tab.labelKey), hint: dt(tab.hintKey) })),
    [i18n.language],
  );

  // Один власник системного монітора на всю панель. Окремі секції змонтовані
  // одночасно, тому їхні start/stop змагалися й могли вимкнути метрики посеред прогону.
  useEffect(() => {
    invoke("start_metrics").catch(console.error);
    return () => {
      invoke("stop_metrics").catch(console.error);
    };
  }, []);

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

  const [allModels, setAllModels] = useState([]);
  useEffect(() => {
    import("../ipc").then(({ rpc }) => {
      rpc("ollama.getModels").then((models) => {
        if (Array.isArray(models)) setAllModels(models);
      }).catch(err => console.error(err));
    });
  }, []);

  const embedModels = useMemo(() => embedModelsOf(config), [config]);
  const chatModels = useMemo(() => {
    const list = allModels.filter(m => !m.includes("embed") && !m.includes("bge") && !m.includes("vision") && !m.includes("vl") && !m.includes("llava"));
    return [...new Set(list.length > 0 ? list : allModels)];
  }, [allModels]);

  // Осі бенчмарку живуть на рівні панелі: форма стоїть у секції прогону, а
  // повний прогін запускає рівно ту матрицю, яку людина бачить у формі.
  const benchmark = useBenchmarkAxes();

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

  const { size: splitSize, containerRef: splitContainerRef, startDrag } = useSplitter(60);

  return (
    <main className="dp-root">
      <header className="dp-head">
        <span className="dp-title">{dt("title")}</span>
        <span className="row dp-small muted">
          {anyRunning ? (
            <span className="dp-warn">{dt("running", { count: runningCount })}</span>
          ) : (
            <span>{dt("idle")}</span>
          )}
          <span className="dp-badge">{dt("userMode")}</span>
        </span>
      </header>

      <DevTabs tabs={translatedTabs} active={activeTab} onSelect={selectTab} runningCounts={runningCounts} />

      <div className="dp-body" ref={splitContainerRef} style={{ "--split-size": `${splitSize}%` }}>
        <div className="dp-col dp-col-main" ref={colRef}>
          {pane(
            "run",
            <>
              <FullRunSection
                ops={ops}
                run={run}
                cancelOp={cancelOp}
                pauseOp={pauseOp}
                resumeOp={resumeOp}
                testConcurrency={config?.rag?.testConcurrency || 1}
                note={note}
                embedModels={embedModels} chatModels={chatModels} configChatModel={config?.ollama?.chatModel || null}
                configModel={config?.embedModelName || null}
                benchmark={benchmark}
                onFinished={onFullRunFinished}
              />
              <PipelineSection ops={ops} run={run} cancelOp={cancelOp} embedModels={embedModels} />
            </>,
          )}

          {pane(
            "results",
            <>
              <StatsSection ops={ops} run={run} cancelOp={cancelOp} refreshKey={statsRefresh} />
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

        <Splitter onPointerDown={startDrag} />

        <div className="dp-col dp-col-log">
          <ProgressLog entries={logEntries} dropped={logDropped} onClear={clearLog} />
        </div>
      </div>
    </main>
  );
}
