/** Точка входу окремого вікна підказки. Головне вікно живе в src/main.jsx. */
import React from "react";
import ReactDOM from "react-dom/client";
import WalkthroughWindow from "./WalkthroughWindow";
import "../i18n";
import "../ui.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <WalkthroughWindow />
  </React.StrictMode>,
);
