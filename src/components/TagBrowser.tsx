import { useEffect, useState } from "react";
import { commands, type NoteRef, type TagCount } from "../bindings";
import { useImeInput } from "../lib/ime";
import { typeLabel, useVault } from "../stores/vault";

/** 태그 대시보드: 전체 태그 열람 → 태그 클릭 → 해당 노트 목록 */
export default function TagBrowser() {
  const { notes, schemas, openNote } = useVault();
  const [tags, setTags] = useState<TagCount[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tagNotes, setTagNotes] = useState<NoteRef[]>([]);
  const refresh = useVault((s) => s.refresh);
  /** 이름을 고치는 중인 태그 */
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

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

  /** 이름 바꾸기 — 이미 있는 이름을 적으면 그게 곧 병합이다 */
  async function rename(from: string, to: string) {
    const target = to.trim();
    if (busy || !target || target === from) {
      setEditing(null);
      return;
    }
    setBusy(true);
    setError("");
    setNote("");
    const merging = tags.some((t) => t.tag === target);
    const r = await commands.renameTag(from, target);
    setBusy(false);
    if (r.status === "error") {
      setError(r.error);
      return;
    }
    setEditing(null);
    setSelected(target);
    setNote(
      merging
        ? `#${from}을 #${target}에 합쳤습니다 (노트 ${r.data}개)`
        : `#${from} → #${target} (노트 ${r.data}개)`,
    );
    await refresh(); // 목록·태그를 다시 읽는다
  }

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
          frontmatter 태그와 본문 #태그를 모두 모아 보여줍니다 · 태그의 ✏️로 이름을
          바꾸고, 있는 이름을 적으면 합쳐집니다
        </p>
        {note && <p className="mt-1 text-xs text-emerald-600">{note}</p>}
        {error && <p className="mt-1 text-xs text-rose-500">{error}</p>}
      </header>

      <div className="flex flex-wrap content-start gap-2 border-b border-neutral-100 px-6 py-3">
        {tags.length === 0 && (
          <p className="text-sm text-neutral-400">
            아직 태그가 없습니다. 노트의 태그 필드나 본문 #태그로 붙일 수 있어요.
          </p>
        )}
        {tags.map((t) =>
          editing === t.tag ? (
            <RenameTag
              key={t.tag}
              from={t.tag}
              busy={busy}
              onDone={(to) => rename(t.tag, to)}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <span
              key={t.tag}
              className={`flex items-center rounded-full text-sm ${
                selected === t.tag
                  ? "bg-violet-600 text-white"
                  : "bg-violet-50 text-violet-700"
              }`}
            >
              <button
                className="rounded-l-full py-1 pl-3 pr-1 hover:opacity-80"
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
              <button
                className="rounded-r-full py-1 pl-1 pr-2.5 text-xs opacity-60 hover:opacity-100"
                onClick={() => {
                  setEditing(t.tag);
                  setNote("");
                  setError("");
                }}
                title="이름 바꾸기 (있는 이름을 적으면 합쳐집니다)"
              >
                ✏️
              </button>
            </span>
          ),
        )}
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

/** 태그 이름 바꾸기 입력칸 — 한글 조합이 안전한 입력을 쓴다 */
function RenameTag({
  from,
  busy,
  onDone,
  onCancel,
}: {
  from: string;
  busy: boolean;
  onDone: (to: string) => void;
  onCancel: () => void;
}) {
  const ime = useImeInput<HTMLInputElement>((v) => onDone(v), "enter", onCancel);
  return (
    <span className="flex items-center gap-1 rounded-full bg-violet-100 py-0.5 pl-2 pr-1">
      <span className="text-sm text-violet-500">#</span>
      <input
        autoFocus
        className="w-28 rounded border border-violet-300 bg-white px-1.5 py-0.5 text-sm focus:border-violet-500 focus:outline-none"
        defaultValue={from}
        disabled={busy}
        {...ime.handlers}
      />
      <button
        className="rounded px-1.5 py-0.5 text-xs text-violet-700 hover:bg-violet-200 disabled:opacity-40"
        disabled={busy}
        onClick={() => onDone(ime.value())}
      >
        바꾸기
      </button>
      <button
        className="rounded px-1 py-0.5 text-xs text-neutral-500 hover:bg-white"
        onClick={onCancel}
      >
        취소
      </button>
    </span>
  );
}
