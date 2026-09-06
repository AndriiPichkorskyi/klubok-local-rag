/**
 * Стан осей бенчмарку + ціна прогону до його запуску.
 *
 * Дві речі, заради яких хук існує:
 *   1) У стані лежать ЛИШЕ ті осі, які людина справді змінила. Решта приходить
 *      із конфіга (його віддає сам бекенд у `tests.plan.configAxes`), і в
 *      `tests.run({axes})` їде теж лише змінене — конфіг лишається джерелом
 *      за замовчуванням, а не копіюється у фронтенд.
 *   2) На кожну зміну хук питає `tests.plan` (з паузою 250 мс, щоб набір
 *      тексту не давав шквалу викликів) і показує, скільки буде режимів,
 *      прогонів і скільки це приблизно триватиме. Нічний прогін мають
 *      оцінювати ДО запуску, а не за фактом.
 *
 * Метод `tests.plan` перевіряє осі тим самим кодом, що й прогін, тож помилку
 * в полі («не число», невідомий режим пошуку, перевищений maxModes) видно
 * одразу і рівно тими самими словами, якими про неї сказав би сам бенчмарк.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { rpc } from "../ipc";
import { errorText } from "./format";
import {
  AXIS_IDS,
  FALLBACK_AXES,
  effectiveAxes,
  formatAxisValues,
  parseAxisInput,
  toggleAxisValue,
} from "./benchmarkAxes";
import { dt } from "./i18n";

/** Види бенчмарку і методи, якими вони запускаються. */
export const BENCHMARK_KINDS = [
  { id: "rag", method: "tests.run", labelKey: "benchmark.rag" },
  { id: "external", method: "tests.runExternal", labelKey: "benchmark.external" },
];

/** Пауза перед запитом плану: людина ще друкує «0.1, 0.5, …». */
const PLAN_DEBOUNCE_MS = 250;

export function useBenchmarkAxes() {
  const { i18n } = useTranslation();
  /** Осі, змінені людиною. Порожньо = все з конфіга. */
  const [overrides, setOverrides] = useState({});
  /** Сирий текст полів-переліків: показуємо саме те, що набрали. */
  const [texts, setTexts] = useState({});
  /** Помилки розбору по осях. Поки вони є, план не питаємо. */
  const [fieldErrors, setFieldErrors] = useState({});
  const [plans, setPlans] = useState({});
  const [planError, setPlanError] = useState(null);
  const [planning, setPlanning] = useState(false);

  // Помилки форми — теж текст інтерфейсу, тому перемальовуємо їх після зміни мови.
  useEffect(() => {
    const next = {};
    for (const [axisId, text] of Object.entries(texts)) {
      const { error } = parseAxisInput(axisId, text);
      if (error) next[axisId] = error;
    }
    for (const [axisId, values] of Object.entries(overrides)) {
      if (Array.isArray(values) && values.length === 0) next[axisId] = dt("benchmark.atLeastOne");
    }
    setFieldErrors(next);
    // Тексти та значення навмисно не є залежностями: вони оновлюють помилки у своїх обробниках.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i18n.resolvedLanguage]);

  // Ключ-рядок: об'єкт `overrides` щоразу новий за посиланням, і ефект
  // зациклився б на власному стані.
  const axesKey = JSON.stringify(overrides);
  const axesParam = useMemo(() => {
    const value = JSON.parse(axesKey);
    return Object.keys(value).length > 0 ? value : null;
  }, [axesKey]);

  const hasFieldErrors = Object.keys(fieldErrors).length > 0;
  // Лічильник відповідей: повільна відповідь на старі осі не має перекривати
  // свіжу (класична гонка при наборі тексту).
  const seqRef = useRef(0);

  useEffect(() => {
    if (hasFieldErrors) return undefined;
    const token = ++seqRef.current;
    const timer = setTimeout(async () => {
      setPlanning(true);
      try {
        const answers = await Promise.all(
          BENCHMARK_KINDS.map((kind) => rpc("tests.plan", { kind: kind.id, axes: axesParam })),
        );
        if (token !== seqRef.current) return;
        const next = {};
        BENCHMARK_KINDS.forEach((kind, index) => {
          next[kind.id] = answers[index];
        });
        setPlans(next);
        setPlanError(null);
      } catch (error) {
        if (token !== seqRef.current) return;
        setPlans({});
        setPlanError(errorText(error));
      } finally {
        if (token === seqRef.current) setPlanning(false);
      }
    }, PLAN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [axesKey, axesParam, hasFieldErrors]);

  /** Осі з конфіга — так, як їх бачить бекенд (уже з дефолтами). */
  const configAxes = plans.rag?.configAxes || plans.external?.configAxes || FALLBACK_AXES;
  const axes = useMemo(() => effectiveAxes(configAxes, overrides), [configAxes, overrides]);

  /** Перемикання значення осі-переліку. Порожня вісь — помилка, а не «всі». */
  const toggleValue = useCallback(
    (axisId, value) => {
      const next = toggleAxisValue(axes[axisId] || [], value);
      setOverrides((prev) => ({ ...prev, [axisId]: next }));
      setFieldErrors((prev) => {
        const copy = { ...prev };
        if (next.length === 0) copy[axisId] = dt("benchmark.atLeastOne");
        else delete copy[axisId];
        return copy;
      });
    },
    [axes],
  );

  /** Поле-перелік: тримаємо і текст, і розібрані значення. */
  const setListText = useCallback((axisId, text) => {
    setTexts((prev) => ({ ...prev, [axisId]: text }));
    const { values, error } = parseAxisInput(axisId, text);
    setFieldErrors((prev) => {
      const copy = { ...prev };
      if (error) copy[axisId] = error;
      else delete copy[axisId];
      return copy;
    });
    if (!error) setOverrides((prev) => ({ ...prev, [axisId]: values }));
  }, []);

  /** Повернути одну вісь до конфіга. */
  const resetAxis = useCallback((axisId) => {
    setOverrides((prev) => {
      const copy = { ...prev };
      delete copy[axisId];
      return copy;
    });
    setTexts((prev) => {
      const copy = { ...prev };
      delete copy[axisId];
      return copy;
    });
    setFieldErrors((prev) => {
      const copy = { ...prev };
      delete copy[axisId];
      return copy;
    });
  }, []);

  const resetAll = useCallback(() => {
    setOverrides({});
    setTexts({});
    setFieldErrors({});
  }, []);

  /** Текст у полі: набране людиною або значення з конфіга. */
  const textOf = useCallback(
    (axisId) => texts[axisId] ?? formatAxisValues(axisId, axes[axisId] || []),
    [texts, axes],
  );

  /** Чи ця вісь узята з конфіга (тобто людина її не чіпала). */
  const isFromConfig = useCallback((axisId) => !(axisId in overrides), [overrides]);

  /** Чи запобіжник maxModes не дає запустити саме цей вид тестів. */
  const blockedFor = useCallback((kindId) => Boolean(plans[kindId]?.blocked), [plans]);

  return {
    axisIds: AXIS_IDS,
    axes,
    configAxes,
    overrides,
    axesParam,
    plans,
    planError,
    planning,
    fieldErrors,
    hasFieldErrors,
    changedCount: Object.keys(overrides).length,
    toggleValue,
    setListText,
    resetAxis,
    resetAll,
    textOf,
    isFromConfig,
    blockedFor,
  };
}
