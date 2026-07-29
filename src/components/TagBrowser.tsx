import { useEffect, useState } from "react";
import { commands, type NoteRef, type TagCount } from "../bindings";
import { typeLabel, useVault } from "../stores/vault";

/** 태그 대시보드: 전체 태그 열람 → 태그 클릭 → 해당 노트 목록 */
export default function TagBrowser() {
  const { notes, schemas, openNote } = useVault();
  const [tags, setTags] = useState<TagCount[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tagNotes, setTagNotes] = useState<NoteRef[]>([]);

  // notes가 바뀔 때마다(저장·생성·삭제 후) 태그 목록 갱신
  useEffect(() => {
    let alive = true;
    commands.getTags().then((r) => {
      if (alive && r.status === "ok") {
        setTags(r.data);
        // 선택된 태그가 사라졌으면 해제
        if (selected && !r.data.some((t) => t.tag === selected)) {
          setSelected(null);
        }
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  useEffect(() => {
    if (!selected) {
      setTagNotes([]);
      return;
    }
    let alive = true;
    commands.notesByTag(selected).then((r) => {
      if (alive && r.status === "ok") setTagNotes(r.data);
    });
    return () => {
      alive = false;
    };
  }, [selected, notes]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-neutral-200 px-6 py-3">
        <h1 className="text-lg font-bold">
          태그{" "}
          <span className="text-sm font-normal text-neutral-400">
            {tags.length}개
          </span>
        </h1>
        <p className="mt-0.5 text-xs text-neutral-400">
          frontmatter 태그와 본문 #태그를 모두 모아 보여줍니다
        </p>
      </header>

      <div className="flex flex-wrap content-start gap-2 border-b border-neutral-100 px-6 py-3">
        {tags.length === 0 && (
          <p className="text-sm text-neutral-400">
            아직 태그가 없습니다. 노트의 태그 필드나 본문 #태그로 붙일 수 있어요.
          </p>
        )}
        {tags.map((t) => (
          <button
            key={t.tag}
            className={`rounded-full px-3 py-1 text-sm ${
              selected === t.tag
                ? "bg-violet-600 text-white"
                : "bg-violet-50 text-violet-700 hover:bg-violet-100"
            }`}
            onClick={() => setSelected(selected === t.tag ? null : t.tag)}
          >
            #{t.tag}
            <span
              className={`ml-1.5 text-xs ${
                selected === t.tag ? "text-violet-200" : "text-violet-400"
              }`}
            >
              {t.count}
            </span>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {selected ? (
          <>
            <h2 className="mb-2 text-sm font-semibold text-neutral-600">
              #{selected} 노트 {tagNotes.length}개
            </h2>
            <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white">
              {tagNotes.map((n) => (
                <li key={n.rel_path}>
                  <button
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-neutral-50"
                    onClick={() => openNote(n.rel_path)}
                  >
                    <span className="w-20 shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-center text-2xs text-neutral-500">
                      {typeLabel(schemas, n.note_type)}
                    </span>
                    <span className="truncate text-sm">{n.title}</span>
                    <span className="ml-auto shrink-0 text-xs text-neutral-400">
                      {n.date}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-12 text-center text-sm text-neutral-400">
            태그를 선택하면 해당 노트 목록이 표시됩니다
          </p>
        )}
      </div>
    </div>
  );
}
