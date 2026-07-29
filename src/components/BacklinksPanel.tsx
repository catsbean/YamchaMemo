import { useEffect, useState } from "react";
import { commands, type Backlink } from "../bindings";
import { typeLabel, useVault } from "../stores/vault";

/** 이 노트를 가리키는 노트들 — 링크로 이어진 것과, 제목만 언급한 것.
 *
 *  각 항목에 링크가 쓰인 대목(문맥)을 함께 보여 준다. 제목만 봐서는
 *  "왜 여기서 나를 가리키는지"를 알 수 없어서, 그 줄이 곧 답이 된다. */
export default function BacklinksPanel({ relPath }: { relPath: string }) {
  const openNote = useVault((s) => s.openNote);
  const schemas = useVault((s) => s.schemas);
  const [links, setLinks] = useState<Backlink[]>([]);
  const [open, setOpen] = useState(true);
  const [showUnlinked, setShowUnlinked] = useState(false);

  useEffect(() => {
    let alive = true;
    setLinks([]);
    commands.getBacklinksDetailed(relPath).then((r) => {
      if (alive && r.status === "ok") setLinks(r.data);
    });
    return () => {
      alive = false;
    };
  }, [relPath]);

  const linked = links.filter((l) => !l.unlinked);
  const unlinked = links.filter((l) => l.unlinked);
  if (linked.length === 0 && unlinked.length === 0) return null;

  const shown = showUnlinked ? unlinked : linked;

  return (
    <div className="max-h-56 shrink-0 overflow-y-auto border-t border-neutral-200 bg-neutral-50 px-4 py-2">
      <div className="mb-1.5 flex items-center gap-2">
        <button
          className="text-xs font-semibold text-neutral-500 hover:text-neutral-800"
          onClick={() => setOpen((v) => !v)}
          title={open ? "접기" : "펼치기"}
        >
          {open ? "▾" : "▸"} 백링크 {linked.length}
        </button>
        {unlinked.length > 0 && open && (
          <span className="flex gap-1 text-[11px]">
            <TabButton
              on={!showUnlinked}
              onClick={() => setShowUnlinked(false)}
              label={`연결됨 ${linked.length}`}
            />
            <TabButton
              on={showUnlinked}
              onClick={() => setShowUnlinked(true)}
              label={`언급만 ${unlinked.length}`}
            />
          </span>
        )}
      </div>

      {open && (
        <>
          {showUnlinked && (
            <p className="mb-1.5 text-[11px] text-neutral-400">
              제목이 나오지만 아직 <code>[[링크]]</code>로 잇지 않은 노트입니다.
            </p>
          )}
          {shown.length === 0 ? (
            <p className="text-xs text-neutral-400">없습니다.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {shown.map((l) => (
                <li
                  key={l.rel_path}
                  className="rounded-md border border-neutral-200 bg-white px-2.5 py-1.5"
                >
                  <button
                    className="flex w-full items-baseline gap-1.5 text-left"
                    onClick={() => openNote(l.rel_path)}
                    title={l.rel_path}
                  >
                    <span className="shrink-0 text-[10px] text-neutral-400">
                      {typeLabel(schemas, l.note_type)}
                    </span>
                    <span className="truncate text-xs font-medium text-neutral-800 hover:underline">
                      {l.title}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] text-neutral-300">
                      {l.date}
                    </span>
                  </button>
                  {l.contexts.map((c, i) => (
                    <p
                      key={i}
                      className="mt-1 border-l-2 border-neutral-200 pl-2 text-[11px] leading-relaxed text-neutral-500"
                    >
                      {c}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function TabButton({
  on,
  onClick,
  label,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      className={`rounded px-1.5 py-0.5 ${
        on
          ? "bg-neutral-800 text-white"
          : "text-neutral-500 hover:bg-neutral-200"
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
