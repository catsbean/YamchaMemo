import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import NoteWindow from "./components/NoteWindow";
import TodoWindow from "./components/TodoWindow";
import TrashWindow from "./components/TrashWindow";
import { useVault } from "./stores/vault";
import "./styles.css";

// 별도 창은 ?view= 로 구분한다 (메인 앱 로직은 실행하지 않음)
//   ?view=trash            → 휴지통
//   ?view=note&rel=<경로>  → 노트 한 편
const params = new URLSearchParams(window.location.search);
const view = params.get("view");
const rel = params.get("rel") ?? "";

function Root() {
  if (view === "trash") return <TrashWindow />;
  if (view === "note" && rel) return <NoteWindow relPath={rel} />;
  if (view === "todos" && rel) return <TodoWindow relPath={rel} />;
  return <App />;
}

/** 화면이 무너졌을 때의 마지막 저장 — 메인 창은 스토어가 현재 노트를 들고 있다.
 *  (노트 창은 3초 자동 저장이 따로 돌아 여기서 손댈 것이 없다) */
async function rescueMainWindow() {
  const s = useVault.getState();
  if (s.dirty) await s.saveCurrent();
}

// 렌더 밖에서 터진 오류(비동기 호출 등)는 경계가 못 잡는다 — 조용히 사라지지 않게
// 스토어 에러로 올려 화면 우하단 알림에 보여 준다.
window.addEventListener("error", (e) => {
  useVault.getState().setError(`오류: ${e.message}`);
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason instanceof Error ? e.reason.message : String(e.reason);
  useVault.getState().setError(`처리되지 않은 오류: ${reason}`);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary rescue={view ? undefined : rescueMainWindow}>
      <Root />
    </ErrorBoundary>
  </React.StrictMode>,
);
