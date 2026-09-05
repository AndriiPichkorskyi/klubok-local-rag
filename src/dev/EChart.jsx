/**
 * Обгортка ECharts для панелі розробника.
 */
import { useCallback, useEffect, useRef } from "react";
import ReactEChartsCore from "echarts-for-react/lib/core";
import * as echarts from "echarts/core";
import { BarChart, HeatmapChart, ScatterChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  HeatmapChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

/** Пауза після останньої зміни розміру, після якої графік перемальовується. */
const RESIZE_DEBOUNCE_MS = 140;

export default function EChart({ onChartReady, ...props }) {
  const observerRef = useRef(null);
  const timerRef = useRef(null);

  const stopWatching = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
  }, []);

  const handleReady = useCallback(
    (instance) => {
      stopWatching();

      const dom = instance?.getDom?.();
      if (dom && typeof ResizeObserver !== "undefined") {
        observerRef.current = new ResizeObserver(() => {
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            if (!dom.clientWidth || !dom.clientHeight) return;
            // Графік могли розмонтувати за час паузи.
            if (!instance.isDisposed?.()) instance.resize();
          }, RESIZE_DEBOUNCE_MS);
        });
        observerRef.current.observe(dom);
      }

      onChartReady?.(instance);
    },
    [onChartReady, stopWatching],
  );

  useEffect(() => stopWatching, [stopWatching]);

  return (
    <ReactEChartsCore
      echarts={echarts}
      notMerge
      lazyUpdate
      {...props}
      onChartReady={handleReady}
    />
  );
}
