import { useEffect, useState } from "react";
import { commands, type HistoryItem } from "../bindings";
import { useVault } from "../stores/vault";
import Modal from "./Modal";

/** 편집 기록 열기 버튼 — 편집기 헤더 공용 */
export function HistoryButton({ relPath }: { relPath: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
        onClick={() => setOpen(true)}
        title="편집 기록 — 저장 직전 내용으로 되돌리기"
      >
        🕘
      </button>
      {open && <HistoryModal relPath={relPath} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 편집 기록 — 저장 직전 상태들을 보여주고 되돌린다.
 *  휴지통이 "지운 파일"을 살린다면, 여기는 "지워진 문단"을 살린다. */
export default function HistoryModal({
  relPath,
  onClose,
}: {
  relPath: string;
  onClose: () => void;
}) {
  const reloadCurrent = useVault((s) => s.reloadCurrent);
  const refresh = useVault((s) => s.refresh);
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    commands.listHistory(relPath).then((r) => {
      if (r.status === "ok") {
        setItems(r.data);
        if (r.data[0]) setSelected(r.data[0].stamp);
      } else {
        setError(r.error);
        setItems([]);
      }
    });
  }, [relPath]);

  useEffect(() => {
    if (!selected) return;
    setConfirming(false);
    commands.readHistory(relPath, selected).then((r) => {
      setPreview(r.status === "ok" ? r.data : "");
    });
  }, [relPath, selected]);

  async function restore() {
    if (!selected || busy) return;
    setBusy(true);
    const r = await commands.restoreHistory(relPath, selected);
    setBusy(false);
    if (r.status === "ok") {
      await refresh();
      await reloadCurrent();
      onClose();
    } else {
      setError(r.error);
    }
  }

  return (
    <Modal
      onClose={onClose}
      locked={busy}
      panelClassName="flex h-[80vh] w-[52rem] flex-col rounded-lg p-5 shadow-xl"
    >
      <h2 className="text-base font-bold">편집 기록</h2>
      <p className="mt-1 text-xs text-neutral-400">
        저장하기 직전의 내용을 남겨 둡니다. 되돌리기 전 상태도 기록에 남으니
        안심하고 눌러도 됩니다.
      </p>

      <div className="mt-3 flex min-h-0 flex-1 gap-3">
        <ul className="w-52 shrink-0 overflow-y-auto rounded border border-neutral-200">
          {items === null && (
            <li className="px-3 py-2 text-xs text-neutral-400">불러오는 중…</li>
          )}
          {items?.length === 0 && (
            <li className="px-3 py-4 text-center text-xs text-neutral-400">
              아직 기록이 없습니다
            </li>
          )}
          {items?.map((h) => (
            <li key={h.stamp}>
              <button
                className={`w-full px-3 py-2 text-left text-xs ${
                  selected === h.stamp
                    ? "bg-neutral-800 text-white"
                    : "hover:bg-neutral-50"
                }`}
                onClick={() => setSelected(h.stamp)}
              >
                <span className="block">{h.saved_at}</span>
                <span
                  className={
                    selected === h.stamp
                      ? "text-neutral-300"
                      : "text-neutral-400"
                  }
                >
                  {h.char_count.toLocaleString()}자
                </span>
              </button>
            </li>
          ))}
        </ul>

        <pre className="min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs leading-relaxed text-neutral-700">
          {preview || (items?.length ? "" : "왼쪽에서 시점을 골라주세요")}
        </pre>
      </div>

      {error && <p className="mt-2 text-xs text-rose-500">{error}</p>}

      <div className="mt-3 flex items-center justify-end gap-2">
        {confirming ? (
          <>
            <span className="mr-auto text-xs text-neutral-500">
              지금 내용을 이 시점으로 되돌립니다.
            </span>
            <button
              className="rounded px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100"
              onClick={() => setConfirming(false)}
            >
              취소
            </button>
            <button
              className="rounded bg-rose-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-rose-500 disabled:opacity-40"
              disabled={busy}
              onClick={restore}
            >
              되돌리기 확인
            </button>
          </>
        ) : (
          <>
            <button
              className="rounded px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100"
              onClick={onClose}
            >
              닫기
            </button>
            <button
              className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-white hover:bg-neutral-600 disabled:opacity-40"
              disabled={!selected || busy}
              onClick={() => setConfirming(true)}
            >
              이 시점으로 되돌리기
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
