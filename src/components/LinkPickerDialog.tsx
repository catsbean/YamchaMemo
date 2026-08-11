import { useEffect, useState } from "react";
import type { TypeDef } from "../bindings";
import { isImeEnter } from "../lib/ime";
import type { LinkHit } from "../lib/resolveLink";
import { useVault } from "../stores/vault";
import Modal from "./Modal";

/** 메인 창용 — 스토어에 걸린 겹치는 링크가 있으면 고르는 창을 띄운다. */
export default function LinkPickerDialog() {
  const linkChoice = useVault((s) => s.linkChoice);
  const clearLinkChoice = useVault((s) => s.clearLinkChoice);
  const openNote = useVault((s) => s.openNote);
  const schemas = useVault((s) => s.schemas);

  if (!linkChoice) return null;
  return (
    <LinkPicker
      target={linkChoice.target}
      hits={linkChoice.hits}
      schemas={schemas}
      onPick={(rel) => {
        clearLinkChoice();
        openNote(rel);
      }}
      onClose={clearLinkChoice}
    />
  );
}

/** 이름이 겹치는 `[[링크]]`에서 어느 글인지 고르는 창.
 *
 *  자유노트와 회의록에 '중복노트'가 하나씩 있으면 `[[중복노트]]`만으로는 어느
 *  쪽인지 알 수 없다. 예전에는 목록에서 먼저 걸린 하나를 말없이 열었는데, 그건
 *  둘 중 하나를 몰래 고르는 것이라 사용자가 틀린 글을 보고 있어도 알 수가 없다.
 *  분류와 폴더 경로를 나란히 보여 주고 사람이 고르게 한다.
 *
 *  **스토어를 보지 않는다** — 별도 노트 창은 스토어를 초기화하지 않는데, 거기서도
 *  같은 창이 떠야 한다. 고른 뒤 무엇을 할지(같은 창에서 열기 / 새 창으로 열기)는
 *  부르는 쪽이 정한다. */
export function LinkPicker({
  target,
  hits,
  schemas,
  onPick,
  onClose,
}: {
  target: string;
  hits: LinkHit[];
  schemas: TypeDef[];
  onPick: (relPath: string) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(0);

  // 링크는 글을 쓰는 흐름 한가운데서 눌린다 — 손을 마우스로 옮기게 하지 않는다.
  // (Esc는 Modal이 맡는다.) capture 단계에서 잡아 뒤쪽 화면의 단축키로 새지 않게 한다.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const n = hits.length;
      if (e.key === "ArrowDown") {
        setActive((i) => (i + 1) % n);
      } else if (e.key === "ArrowUp") {
        setActive((i) => (i - 1 + n) % n);
      } else if (e.key === "Enter") {
        // 조합 중 Enter는 한글을 확정하려는 것이다 (다른 칸에 포커스가 있을 수 있다)
        if (isImeEnter({ nativeEvent: e, key: e.key })) return;
        setActive((i) => {
          onPick(hits[i].note.rel_path);
          return i;
        });
      } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) {
        onPick(hits[Number(e.key) - 1].note.rel_path);
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [hits, onPick]);

  return (
    <Modal onClose={onClose} panelClassName="w-96 rounded-lg p-5 shadow-xl">
      <h2 className="text-base font-bold">
        <span className="text-neutral-500">[[</span>
        {target}
        <span className="text-neutral-500">]]</span>
      </h2>
      <p className="mt-1 text-xs text-neutral-500">
        같은 이름의 글이 {hits.length}개 있습니다. 열 글을 고르세요 — ↑↓·Enter
        또는 번호키.
      </p>

      <ul className="mt-3 flex flex-col gap-1">
        {hits.map(({ note, via, alias }, i) => (
          <li key={note.rel_path}>
            <button
              className={`flex w-full flex-col items-start rounded-md border px-3 py-2 text-left ${
                i === active
                  ? "border-neutral-800 bg-neutral-50"
                  : "border-neutral-200 hover:border-neutral-400 hover:bg-neutral-50"
              }`}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(note.rel_path)}
            >
              <span className="flex w-full items-center gap-2">
                {i < 9 && (
                  <span className="shrink-0 text-2xs text-neutral-400">
                    {i + 1}
                  </span>
                )}
                <span className="truncate text-sm">
                  {note.title || note.rel_path}
                </span>
                <span className="ml-auto shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-2xs text-neutral-500">
                  {schemas.find((s) => s.id === note.note_type)?.label ??
                    note.note_type}
                </span>
              </span>
              <span className="mt-0.5 w-full truncate text-2xs text-neutral-400">
                {note.rel_path}
                {via === "alias" && alias && ` · 별칭 '${alias}'`}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-2xs text-neutral-400">
        늘 같은 글로 가게 하려면 링크에 폴더를 함께 적으세요 —{" "}
        <code>[[{hits[0].note.rel_path.replace(/\.md$/, "")}]]</code>
      </p>

      <div className="mt-3 flex justify-end">
        <button
          className="rounded px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100"
          onClick={onClose}
        >
          취소
        </button>
      </div>
    </Modal>
  );
}
