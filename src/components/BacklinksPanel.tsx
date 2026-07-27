import { useEffect, useState } from "react";
import { commands, type NoteRef } from "../bindings";
import { typeLabel, useVault } from "../stores/vault";

/** 현재 노트를 가리키는 노트들 (편집 화면 하단) */
export default function BacklinksPanel({ relPath }: { relPath: string }) {
  const openNote = useVault((s) => s.openNote);
  const schemas = useVault((s) => s.schemas);
  const [links, setLinks] = useState<NoteRef[]>([]);

  useEffect(() => {
    let alive = true;
    commands.getBacklinks(relPath).then((r) => {
      if (alive && r.status === "ok") setLinks(r.data);
    });
    return () => {
      alive = false;
    };
  }, [relPath]);

  if (links.length === 0) return null;

  return (
    <div className="border-t border-neutral-200 bg-neutral-50 px-4 py-2">
      <h3 className="mb-1 text-xs font-semibold text-neutral-500">
        백링크 {links.length}
      </h3>
      <ul className="flex flex-wrap gap-1.5">
        {links.map((l) => (
          <li key={l.rel_path}>
            <button
              className="flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-700 hover:border-neutral-400"
              onClick={() => openNote(l.rel_path)}
              title={l.rel_path}
            >
              <span className="text-[10px] text-neutral-400">
                {typeLabel(schemas, l.note_type)}
              </span>
              {l.title}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
