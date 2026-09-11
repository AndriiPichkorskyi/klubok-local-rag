/**
 * Кружечок стану кроку: галочка — крок пройдено, спінер — виконується зараз,
 * порожнє коло — попереду.
 *
 * Один компонент на дві поверхні панелі прогресу: точки на нитці
 * (`variant="thread"`) і рядки журналу (`variant="log"`). Відрізняються лише
 * розміром і тим, як показано активний стан: на нитці це кільце навколо точки,
 * у журналі — обертовий спінер.
 */
import { Check, LoaderCircle } from "lucide-react";

const CHECK_SIZE = { thread: 12, log: 13 };

export default function StatusDot({ state = "future", variant = "thread" }) {
  return (
    <span className={`status-dot is-${variant} is-${state}`} aria-hidden="true">
      {state === "done" ? <Check size={CHECK_SIZE[variant] || 12} strokeWidth={3} /> : null}
      {state === "active" && variant === "log" ? <LoaderCircle size={15} /> : null}
    </span>
  );
}
