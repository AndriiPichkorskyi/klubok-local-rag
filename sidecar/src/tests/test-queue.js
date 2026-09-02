import PQueue from "p-queue";

/** Перетворює значення паралельності на додатне ціле число. */
export function normalizeTestConcurrency(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return Math.max(1, Number(fallback) || 1);
  return parsed;
}

/**
 * Керування одним прогоном тестів. Контролер живе в RPC-задачі, а черга
 * змінюється між режимами матриці. Тому пауза, натиснута під час прогріву або
 * між режимами, запам'ятовується і застосовується до наступної черги.
 */
export function createTestRunControl(concurrency) {
  let queue = null;
  let paused = false;
  let currentConcurrency = normalizeTestConcurrency(concurrency);

  const snapshot = () => ({
    paused,
    concurrency: currentConcurrency,
    active: queue?.pending || 0,
    queued: queue?.size || 0,
  });

  return {
    attach(nextQueue) {
      queue = nextQueue;
      queue.concurrency = currentConcurrency;
      if (paused) queue.pause();
      else queue.start();
      return snapshot();
    },

    detach(currentQueue) {
      if (queue === currentQueue) queue = null;
    },

    pause() {
      paused = true;
      queue?.pause();
      return snapshot();
    },

    resume(nextConcurrency = currentConcurrency) {
      currentConcurrency = normalizeTestConcurrency(nextConcurrency, currentConcurrency);
      paused = false;
      if (queue) {
        queue.concurrency = currentConcurrency;
        queue.start();
      }
      return snapshot();
    },

    snapshot,
  };
}

/** Стандартна помилка скасування, яку RPC-сервер повертає як cancelled result. */
function abortError(signal) {
  const error = new Error(signal?.reason?.message || "Тестовий прогін скасовано.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

/**
 * Запускає кейси через керовану чергу. `p-queue` дає pause/start і дозволяє
 * міняти concurrency без перебудови списку задач.
 *
 * При скасуванні нові кейси прибираються з черги, а вже активні спокійно
 * завершуються. Лише після цього функція кидає AbortError, тому потоковий
 * звіт не закриється, поки активний кейс ще дописує свій результат.
 */
export async function runTestQueue(items, worker, options = {}) {
  const queue = new PQueue({
    concurrency: normalizeTestConcurrency(options.concurrency),
    autoStart: false,
  });
  const control = options.control || null;
  let firstError = null;

  const stopQueue = (error) => {
    if (!firstError) firstError = error;
    queue.clear();
  };

  const onAbort = () => {
    queue.clear();
  };

  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    for (const item of items) {
      void queue.add(() => worker(item)).catch(stopQueue);
    }

    control?.attach(queue);
    if (!control) queue.start();
    if (options.signal?.aborted) queue.clear();

    await queue.onIdle();

    if (options.signal?.aborted) throw abortError(options.signal);
    if (firstError) throw firstError;
  } finally {
    if (options.signal) options.signal.removeEventListener("abort", onAbort);
    control?.detach(queue);
  }
}
