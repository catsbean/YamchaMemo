import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { commands } from "../bindings";
import { notifyOtherWindows } from "../lib/windowSync";
import TodoList from "./TodoList";

/** 할 일만 띄우는 좁은 창 — 일지를 열어두지 않고도 체크할 수 있게. */
export default function TodoWindow({ relPath }: { relPath: string }) {
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function reload() {
    const r = await commands.readNote(relPath);
    if (r.status === "ok") setBody(r.data.body);
    else setError(r.error);
  }

  useEffect(() => {
    reload();
    // 다른 창에서 이 노트를 고치면 따라간다
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen<string[]>("vault-external-change", (e) => {
      if (e.payload.includes(relPath)) reload();
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [relPath]);

  const title = relPath.split("/").pop()?.replace(/\.md$/, "") ?? "";

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-white p-6 text-center text-sm text-rose-500">
        {error}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-white text-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-200 px-3 py-2">
        <h1 className="truncate text-xs font-bold" title={title}>
          {title}
        </h1>
        <button
          className="shrink-0 rounded px-2 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100"
          onClick={() => getCurrentWindow().close()}
        >
          닫기
        </button>
      </header>
      <div className="min-h-0 flex-1">
        {body === null ? (
          <p className="p-4 text-center text-xs text-neutral-400">불러오는 중…</p>
        ) : (
          <TodoList
            relPath={relPath}
            body={body}
            showOpenWindow={false}
            onChanged={async (note) => {
              setBody(note.body);
              await notifyOtherWindows([relPath]);
            }}
          />
        )}
      </div>
    </div>
  );
}
