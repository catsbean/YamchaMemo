import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { commands, type TrashItem } from "../bindings";

/** 휴지통 전용 창 — 삭제한 노트를 원래 폴더로 복구한다.
 *  메인 창과 별개의 webview지만 백엔드 vault 상태는 프로세스 전역이라 그대로 접근한다. */
export default function TrashWindow() {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function reload() {
    const r = await commands.listTrash();
    if (r.status === "ok") setItems(r.data);
    else setError(r.error);
    setLoading(false);
  }

  useEffect(() => {
    reload();
  }, []);

  async function restore(fileName: string) {
    if (busy) return;
    setBusy(fileName);
    setError("");
    const r = await commands.restoreTrash(fileName);
    if (r.status === "ok") {
      // 메인 창이 목록·검색을 갱신하도록 알린다 (기존 외부변경 이벤트 재사용)
      await emit("vault-external-change", [r.data]);
      await reload();
    } else {
      setError(r.error);
    }
    setBusy(null);
  }

  return (
    <div className="flex h-screen flex-col bg-white text-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
        <h1 className="text-base font-bold">
          휴지통{" "}
          <span className="text-sm font-normal text-neutral-400">
            {items.length}개
          </span>
        </h1>
        <button
          className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
          onClick={() => getCurrentWindow().close()}
        >
          닫기
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        {error && <p className="mb-2 text-sm text-rose-500">{error}</p>}
        {loading ? (
          <p className="mt-10 text-center text-sm text-neutral-400">
            불러오는 중…
          </p>
        ) : items.length === 0 ? (
          <p className="mt-10 text-center text-sm text-neutral-400">
            휴지통이 비어 있습니다.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {items.map((it) => (
              <li
                key={it.file_name}
                className="flex items-center justify-between gap-2 rounded border border-neutral-200 px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate" title={it.original_name}>
                    {it.original_name.replace(/\.md$/, "")}
                  </span>
                  <span className="text-xs text-neutral-400">
                    {it.deleted_at} 삭제
                  </span>
                </span>
                <button
                  className="shrink-0 rounded border border-neutral-300 px-2.5 py-1 text-xs hover:border-neutral-500 disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => restore(it.file_name)}
                >
                  {busy === it.file_name ? "복구 중…" : "복구"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
