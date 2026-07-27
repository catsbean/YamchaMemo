import { useEffect, useState } from "react";
import { commands } from "../bindings";
import { useVault } from "../stores/vault";
import Modal from "./Modal";

/** 파싱하지 못하는 노트를 원문 그대로 열어 고치는 창.
 *  frontmatter YAML 문법 오류처럼 자동으로 손댈 수 없는 경우의 마지막 수단이다. */
export default function RawEditModal({
  relPath,
  detail,
  onClose,
}: {
  relPath: string;
  detail: string;
  onClose: () => void;
}) {
  const refresh = useVault((s) => s.refresh);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    commands.readRaw(relPath).then((r) => {
      if (r.status === "ok") setText(r.data);
      else setError(r.error);
    });
  }, [relPath]);

  async function save() {
    if (text === null || busy) return;
    setBusy(true);
    const r = await commands.writeRaw(relPath, text);
    setBusy(false);
    if (r.status === "ok") {
      await refresh();
      onClose();
    } else {
      setError(r.error);
    }
  }

  return (
    <Modal
      onClose={onClose}
      locked={busy}
      panelClassName="flex h-[80vh] w-[46rem] flex-col rounded-lg p-5 shadow-xl"
    >
      <h2 className="text-base font-bold">원문 고치기</h2>
      <p className="mt-1 break-all text-xs text-neutral-400">{relPath}</p>
      <p className="mt-2 rounded bg-rose-50 px-3 py-2 text-xs text-rose-600">
        {detail}
      </p>
      <p className="mt-2 text-xs text-neutral-500">
        파일 맨 위 <code>---</code> 사이가 frontmatter입니다. 들여쓰기와 대괄호가
        짝이 맞는지 확인하고 저장해주세요. 저장 전 상태는 편집 기록에 남습니다.
      </p>

      {text === null ? (
        <p className="mt-4 text-sm text-neutral-400">불러오는 중…</p>
      ) : (
        <textarea
          className="mt-3 min-h-0 flex-1 resize-none rounded border border-neutral-300 p-3 font-mono text-xs leading-relaxed focus:border-neutral-500 focus:outline-none"
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}

      {error && <p className="mt-2 text-xs text-rose-500">{error}</p>}

      <div className="mt-3 flex justify-end gap-2">
        <button
          className="rounded px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100"
          onClick={onClose}
        >
          닫기
        </button>
        <button
          className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-white hover:bg-neutral-600 disabled:opacity-40"
          disabled={text === null || busy}
          onClick={save}
        >
          저장
        </button>
      </div>
    </Modal>
  );
}
