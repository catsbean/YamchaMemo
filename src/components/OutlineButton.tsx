import { useEffect, useMemo, useRef, useState } from "react";

/** 본문에서 헤딩 줄만 뽑는다 (코드블록 안의 #는 제외) */
function headings(body: string): { line: number; level: number; text: string }[] {
  const out: { line: number; level: number; text: string }[] = [];
  let inFence = false;
  body.split("\n").forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const m = raw.match(/^(#{1,6})\s+(.*)$/);
    if (m && m[2].trim()) {
      out.push({ line: i + 1, level: m[1].length, text: m[2].trim() });
    }
  });
  return out;
}

/** 목차 — 긴 노트에서 헤딩으로 바로 점프한다. 헤딩이 없으면 버튼 자체가 안 보인다. */
export default function OutlineButton({
  body,
  onJump,
}: {
  body: string;
  onJump: (line: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => headings(body), [body]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div className="relative" ref={boxRef}>
      <button
        className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
        onClick={() => setOpen((v) => !v)}
        title="목차"
      >
        ☰
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 max-h-80 w-64 overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-lg">
          {items.map((h) => (
            <button
              key={`${h.line}-${h.text}`}
              className="block w-full truncate px-3 py-1 text-left text-xs text-neutral-600 hover:bg-neutral-50"
              style={{ paddingLeft: `${0.75 + (h.level - 1) * 0.6}rem` }}
              onClick={() => {
                setOpen(false);
                onJump(h.line);
              }}
              title={h.text}
            >
              {h.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
