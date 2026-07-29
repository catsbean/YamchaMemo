import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Dashboard from "./components/Dashboard";
import EditorPane from "./components/EditorPane";
import SearchModal from "./components/SearchModal";
import Sidebar from "./components/Sidebar";
import { commands, type StorageDir } from "./bindings";
import { useSuppressNativeContextMenu } from "./lib/contextMenu";
import { useVault } from "./stores/vault";

export default function App() {
  const {
    vaultPath,
    initialized,
    error,
    nav,
    current,
    layout,
    init,
    chooseVault,
    startAt,
    clearError,
  } = useVault();

  const [searchOpen, setSearchOpen] = useState(false);
  const [storageDirs, setStorageDirs] = useState<StorageDir[]>([]);

  // 웹뷰 기본 우클릭 메뉴(새로고침·검사 등)를 막는다 — 앱에 맞는 메뉴만 띄운다
  useSuppressNativeContextMenu();

  // 첫 실행 화면: 감지된 저장 위치 후보 로드
  useEffect(() => {
    if (initialized && !vaultPath) {
      commands.detectStorageDirs().then(setStorageDirs);
    }
  }, [initialized, vaultPath]);

  useEffect(() => {
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 창 닫기 시 dirty 노트 플러시 (자동 저장 대기 중 유실 방지)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWindow()
      .onCloseRequested(async (e) => {
        const s = useVault.getState();
        if (!s.dirty && !s.pendingTitleRel) return;
        e.preventDefault();
        try {
          if (s.dirty) await useVault.getState().saveCurrent();
          // 제목 없이 닫는 노트에 이름을 붙여 준다
          const rel = useVault.getState().pendingTitleRel;
          if (rel) await commands.autoTitleNote(rel);
        } finally {
          await getCurrentWindow().destroy();
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Ctrl+K 검색
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!initialized) {
    return (
      <div className="flex h-full items-center justify-center text-neutral-400">
        불러오는 중…
      </div>
    );
  }

  if (!vaultPath) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-5 bg-neutral-50 px-6">
        <h1 className="text-2xl font-bold">YamchaMemo</h1>
        <p className="max-w-sm text-center text-sm text-neutral-500">
          메모를 저장할 위치를 고르세요. 선택한 폴더 아래 YamchaMemo 폴더가
          만들어지고, 모든 메모는 마크다운 파일로 저장됩니다.
        </p>
        <div className="flex w-full max-w-sm flex-col gap-2">
          {storageDirs.map((d) => (
            <button
              key={d.path}
              className="flex flex-col items-start rounded-lg border border-neutral-200 bg-white px-4 py-3 text-left hover:border-neutral-400"
              onClick={() => startAt(d.path)}
            >
              <span className="text-sm font-medium">{d.label}</span>
              <span className="mt-0.5 break-all text-xs text-neutral-400">
                {d.path}\YamchaMemo
              </span>
            </button>
          ))}
          <button
            className="mt-1 self-center text-xs text-neutral-500 underline hover:text-neutral-800"
            onClick={chooseVault}
          >
            다른 위치 직접 선택…
          </button>
        </div>
        {error && <p className="text-sm text-rose-500">{error}</p>}
      </main>
    );
  }

  const editorOpen = !!current;

  return (
    <div className="flex h-full bg-white text-neutral-900">
      <Sidebar onSearch={() => setSearchOpen(true)} />

      {layout === "replace" &&
        (editorOpen ? (
          <EditorPane />
        ) : (
          <div className="min-w-0 flex-1">
            <Dashboard noteType={nav} />
          </div>
        ))}

      {layout === "three" && (
        <>
          <div
            className={`shrink-0 border-r border-neutral-200 ${
              editorOpen ? "w-[24rem]" : "flex-1"
            }`}
          >
            <Dashboard noteType={nav} compact={editorOpen} />
          </div>
          {editorOpen && <EditorPane />}
        </>
      )}

      {layout === "vertical" && (
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            className={
              editorOpen
                ? "h-[38%] min-h-0 border-b border-neutral-200"
                : "min-h-0 flex-1"
            }
          >
            <Dashboard noteType={nav} compact={editorOpen} />
          </div>
          {editorOpen && (
            <div className="min-h-0 flex-1">
              <EditorPane />
            </div>
          )}
        </div>
      )}

      {searchOpen && <SearchModal onClose={() => setSearchOpen(false)} />}
      {error && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg bg-rose-600 px-4 py-2 text-sm text-white shadow-lg">
          <span>{error}</span>
          <button className="font-bold" onClick={clearError}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
