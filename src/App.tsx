import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Dashboard from "./components/Dashboard";
import EditorPane from "./components/EditorPane";
import SearchModal from "./components/SearchModal";
import SettingsModal from "./components/SettingsModal";
import Sidebar from "./components/Sidebar";
import { commands, type StorageDir } from "./bindings";
import { useSuppressNativeContextMenu } from "./lib/contextMenu";
import { useShortcut } from "./lib/shortcuts";
import { isPrinting } from "./lib/exportFile";
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
    startupNotice,
    dismissStartupNotice,
  } = useVault();

  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [storageDirs, setStorageDirs] = useState<StorageDir[]>([]);

  useShortcut("search", () => setSearchOpen((v) => !v));
  useShortcut("settings", () => setSettingsOpen(true));
  // 만들기 창은 대시보드가 들고 있다 — 편집기를 닫고 신호만 보낸다
  useShortcut("newNote", () => useVault.getState().requestCreate());

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
        // 인쇄 미리보기는 앱 화면 위에 겹쳐 뜬다. 그걸 닫는 동작이 창 닫기 요청으로
        // 번져 메모앱이 통째로 닫히는 일이 있었다 — 인쇄 중에는 닫지 않는다.
        if (isPrinting()) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        try {
          if (useVault.getState().dirty) {
            await useVault.getState().saveCurrent();
          }
          // 제목 없이 닫는 노트에 이름을 붙여 준다
          const rel = useVault.getState().pendingTitleRel;
          if (rel) await commands.autoTitleNote(rel);
          // 미러는 한참 쉬었을 때만 도므로, 닫기 전에 밀린 복제를 끝낸다
          await useVault.getState().flushMirrors();
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
      <Sidebar
        onSearch={() => setSearchOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

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
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {startupNotice && (
        <StartupNoticeBanner
          message={startupNotice}
          onDone={dismissStartupNotice}
        />
      )}
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

/** 지정한 시작 탭/글을 못 찾아 홈으로 대신 열었을 때의 안내 —
 *  위에서 잠깐 나타났다가 스스로 사라진다. */
function StartupNoticeBanner({
  message,
  onDone,
}: {
  message: string;
  onDone: () => void;
}) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setShow(true));
    const hide = setTimeout(() => setShow(false), 3000);
    const remove = setTimeout(onDone, 3300);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(hide);
      clearTimeout(remove);
    };
  }, [onDone]);

  return (
    <div
      className={`fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-lg bg-neutral-800 px-4 py-2 text-sm text-white shadow-lg transition-all duration-300 ${
        show ? "translate-y-0 opacity-100" : "-translate-y-3 opacity-0"
      }`}
    >
      {message}
    </div>
  );
}
