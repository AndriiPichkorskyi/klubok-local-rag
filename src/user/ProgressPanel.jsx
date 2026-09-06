import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, LoaderCircle, X } from "lucide-react";
import klubokImage from "../assets/klubok_transparent.png";

const STAGE_TOPS = [20, 13, 24, 11, 21];
const STAGE_PROGRESS = [0, 25, 50, 75, 100];

function formatSeconds(ms, language) {
  return new Intl.NumberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
    .format(Math.max(0, ms) / 1000);
}

function pathForWidth(width) {
  return `M0 35 C${width * 0.09} 5 ${width * 0.14} 62 ${width * 0.23} 32 ` +
    `S${width * 0.39} 8 ${width * 0.47} 38 ` +
    `S${width * 0.62} 60 ${width * 0.7} 29 ` +
    `S${width * 0.85} 6 ${width} 34`;
}

/** Плавно наближає клубок до наступного етапу, не прив'язуючись до швидкості RPC. */
function useMotionProgress(target) {
  const [progress, setProgress] = useState(0);
  const currentRef = useRef(0);

  useEffect(() => {
    const start = currentRef.current;
    if (start === target) return undefined;
    const duration = 720;
    let startedAt = null;
    let frame = null;

    const tick = (timestamp) => {
      if (startedAt === null) startedAt = timestamp;
      const ratio = Math.min(1, (timestamp - startedAt) / duration);
      const eased = ratio * ratio * (3 - 2 * ratio);
      const next = start + (target - start) * eased;
      currentRef.current = next;
      setProgress(next);
      if (ratio < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return progress;
}

export default function ProgressPanel({ query, msg, complete, onComplete, onCancel }) {
  const { t, i18n } = useTranslation();
  const [current, setCurrent] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [uiElapsedMs, setUiElapsedMs] = useState(0);
  const [pathWidth, setPathWidth] = useState(1000);
  const pathRef = useRef(null);
  const progressRef = useRef(null);
  const startedAtRef = useRef(Date.now());

  // Перші чотири етапи мають власний темп. Guide настає лише після відповіді backend.
  useEffect(() => {
    const timers = [
      window.setTimeout(() => setCurrent(1), 650),
      window.setTimeout(() => setCurrent(2), 1350),
      window.setTimeout(() => setCurrent(3), 2050),
    ];
    return () => timers.forEach(window.clearTimeout);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setUiElapsedMs(Date.now() - startedAtRef.current);
    }, 50);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const node = progressRef.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.max(1, Math.round(entry.contentRect.width));
      setPathWidth(width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!complete || current !== 3) return undefined;
    const timer = window.setTimeout(() => setCurrent(4), 520);
    return () => window.clearTimeout(timer);
  }, [complete, current]);

  useEffect(() => {
    if (!complete || current !== 4) return undefined;
    const timer = window.setTimeout(() => setLeaving(true), 850);
    return () => window.clearTimeout(timer);
  }, [complete, current]);

  useEffect(() => {
    if (!leaving) return undefined;
    const timer = window.setTimeout(() => onComplete(), 480);
    return () => window.clearTimeout(timer);
  }, [leaving, onComplete]);

  const motionProgress = useMotionProgress(STAGE_PROGRESS[current]);
  const pathData = useMemo(() => pathForWidth(pathWidth), [pathWidth]);
  let yarnPoint = { x: 0, y: 35 };
  if (pathRef.current) {
    const length = pathRef.current.getTotalLength();
    yarnPoint = pathRef.current.getPointAtLength(length * motionProgress / 100);
  }
  const rotation = motionProgress * 6.4 + uiElapsedMs * 0.055;
  const stages = t("progress.stages", { returnObjects: true });
  const rows = t("progress.rows", { returnObjects: true });

  return (
    <section className={leaving ? "generation is-leaving" : "generation"} aria-live="polite">
      <div className="generation-query">
        <span className="generation-bubble" aria-hidden="true" />
        <strong>{query}</strong>
        <span>{t("common.seconds", { value: formatSeconds(uiElapsedMs, i18n.language) })}</span>
      </div>

      <div ref={progressRef} className="thread-progress" aria-label={t("progress.stageLabel", { current: current + 1, total: 5 })}>
        <svg viewBox={`0 0 ${pathWidth} 70`} aria-hidden="true">
          <path ref={pathRef} className="thread-path is-base" pathLength="100" d={pathData} />
          <path
            className="thread-path is-active"
            pathLength="100"
            strokeDasharray={`${motionProgress} 100`}
            d={pathData}
          />
          <g transform={`translate(${yarnPoint.x} ${yarnPoint.y})`}>
            <image
              className="thread-yarn-image"
              href={klubokImage}
              x="-31"
              y="-31"
              width="62"
              height="62"
              preserveAspectRatio="xMidYMid meet"
              transform={`rotate(${rotation})`}
            />
          </g>
        </svg>
        {stages.map((stage, index) => (
          <div
            key={stage}
            className="thread-stage"
            data-state={index < current ? "done" : index === current ? "active" : "future"}
            style={{ left: `${STAGE_PROGRESS[index]}%`, top: STAGE_TOPS[index] }}
          >
            <span className="thread-dot">
              {index < current ? <Check size={12} strokeWidth={3} /> : null}
            </span>
            <span className="thread-label">{stage}</span>
          </div>
        ))}
      </div>

      <div className="generation-log">
        {rows.map((row, index) => {
          const done = index < current || current === 4;
          const active = index === current && current < 4;
          return (
            <div className="generation-log-row" key={row}>
              <span className={done ? "log-icon is-done" : active ? "log-icon is-active" : "log-icon"}>
                {done ? <Check size={13} strokeWidth={3} /> : active ? <LoaderCircle size={15} /> : null}
              </span>
              <span>{row}</span>
              {done ? <small>{t("common.done")}</small> : active ? <small>{t("common.now")}</small> : null}
            </div>
          );
        })}
      </div>

      <div className="generation-skeletons" aria-hidden="true">
        {[0, 1, 2].map((item) => (
          <div className="result-skeleton" key={item}>
            <div className="skeleton-head"><span /><i /></div>
            <b /><b className="is-short" /><em />
          </div>
        ))}
      </div>

      <div className="generation-footer">
        <span>{t("progress.privacy")}</span>
        {complete ? (
          <span className="generation-ready"><Check size={14} /> {t("progress.ready")}</span>
        ) : (
          <button type="button" onClick={onCancel}><X size={15} /> {t("common.cancel")}</button>
        )}
      </div>
    </section>
  );
}
