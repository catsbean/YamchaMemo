import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import TrashWindow from "./components/TrashWindow";
import "./styles.css";

// ?view=trash 로 열린 별도 창은 휴지통 전용 UI만 띄운다 (메인 앱 로직은 실행하지 않음)
const view = new URLSearchParams(window.location.search).get("view");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {view === "trash" ? <TrashWindow /> : <App />}
  </React.StrictMode>,
);
