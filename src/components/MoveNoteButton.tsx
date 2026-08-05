import { useState } from "react";
import type { TypeDef } from "../bindings";

/** 노트를 다른 분류로 옮기는 버튼 — 눌러 대상 분류를 고르면 파일이 그
 *  분류의 폴더로 옮겨지고 frontmatter type도 함께 바뀐다.
 *  책·데일리는 파일명·폴더 규칙이 확고해 원본·대상 모두에서 뺀다. */
export default function MoveNoteButton({
  schemas,
  currentTypeId,
  onMove,
}: {
  schemas: TypeDef[];
  currentTypeId: string;
  onMove: (newTypeId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const locked = currentTypeId === "book" || currentTypeId === "daily";
  const targets = schemas.filter(
    (s) => s.id !== currentTypeId && s.id !== "book" && s.id !== "daily",
  );

  if (locked || targets.length === 0) return null;

  return (
    <span className="relative">
      <button
        className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
        onClick={() => setOpen((v) => !v)}
        title="다른 분류로 이동"
      >
        이동
      </button>
      {open && (
        <>
          {/* 바깥을 눌러 닫기 */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-40 rounded-md border border-neutral-200 bg-white py-1 shadow-lg">
            {targets.map((s) => (
              <button
                key={s.id}
                className="block w-full px-3 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-100"
                onClick={() => {
                  setOpen(false);
                  onMove(s.id);
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
