import React from "react";
import ReactDOM from "react-dom/client";
import { load } from "@tauri-apps/plugin-store";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import CaptureWindow from "./components/CaptureWindow";
import NoteWindow from "./components/NoteWindow";
import TodoWindow from "./components/TodoWindow";
import TrashWindow from "./components/TrashWindow";
import { applyTheme, useVault, type ThemeMode } from "./stores/vault";
import "./styles.css";

// 별도 창은 ?view= 로 구분한다 (메인 앱 로직은 실행하지 않음)
//   ?view=trash            → 휴지통
//   ?view=note&rel=<경로>  → 노트 한 편
//   ?view=capture          → 빠른 담기 (전역 단축키로 뜨는 작은 창)
const params = new URLSearchParams(window.location.search);
const view = params.get("view");
const rel = params.get("rel") ?? "";

function Root() {
  if (view === "capture") return <CaptureWindow />;
  if (view === "trash") return <TrashWindow />;
  if (view === "note" && rel) return <NoteWindow relPath={rel} />;
  if (view === "todos" && rel) return <TodoWindow relPath={rel} />;
  return <App />;
}

// 화면 밝기를 그리기 전에 입힌다. 메인 창은 init()이 다시 한 번 맞추지만,
// 노트·휴지통 같은 별도 창은 스토어를 초기화하지 않으므로 여기서만 정해진다.
// (설정을 읽는 동안 밝은 화면이 번쩍이지 않게 최대한 일찍 부른다)
load("settings.json", { autoSave: true, defaults: {} }).then(async (s) => {
  applyTheme((await s.get<ThemeMode>("theme")) ?? "light");
});

// "시스템 설정"을 골랐으면 OS 밝기가 바뀔 때 따라간다
window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", async () => {
    const s = await load("settings.json", { autoSave: true, defaults: {} });
    const mode = (await s.get<ThemeMode>("theme")) ?? "light";
    if (mode === "system") applyTheme(mode);
  });

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
