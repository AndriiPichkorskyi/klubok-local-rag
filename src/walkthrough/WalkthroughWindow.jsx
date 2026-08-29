/**
 * Корінь окремого вікна підказки (overlay.html).
 *
 * Вікно не знає нічого наперед: завдання воно бере з запиту, який поклав
 * головний застосунок (див. session.js). Якщо запиту немає — це не біла
 * сторінка, а пояснення, звідки підказка запускається.
 */
import { useCallback, useEffect, useState } from "react";
import WalkthroughPanel from "./WalkthroughPanel";
import { readRequest, clearRequest, REQUEST_KEY } from "./session";
import { overlayHide } from "./tauri";

export default function WalkthroughWindow() {
  const [request, setRequest] = useState(() => readRequest());

  // Нове «Показати як» у головному вікні має перезапустити підказку тут,
  // а не відкрити друге вікно. Вікна одного походження бачать зміни сховища.
  useEffect(() => {
    const onStorage = (event) => {
      if (event?.key && event.key !== REQUEST_KEY) return;
      setRequest(readRequest());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const close = useCallback(() => {
    clearRequest();
    setRequest(null);
    overlayHide().catch(() => {
      /* команди ще немає — вікно просто лишиться відкритим із підсумком */
    });
  }, []);

  return (
    <WalkthroughPanel
      key={request ? `${request.appId}-${request.createdAt}` : "empty"}
      request={request}
      onClose={close}
    />
  );
}
