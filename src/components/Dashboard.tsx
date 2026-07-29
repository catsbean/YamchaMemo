import { useMemo, useState } from "react";
import type { NoteSummary } from "../bindings";
import { useVault } from "../stores/vault";
import { fileSuffix, fmStr } from "../lib/note";
import AuditDashboard from "./AuditDashboard";
import Bookshelf from "./Bookshelf";
import ContextMenu from "./ContextMenu";
import { noteItemHandlers, useContextMenu } from "../lib/contextMenu";
import { openNoteWindow } from "../lib/trashWindow";
import NewNoteDialog from "./NewNoteDialog";
import { useCreateRequest } from "../lib/shortcuts";
import HomeDashboard from "./HomeDashboard";
import ReadingDashboard from "./ReadingDashboard";
import TagBrowser from "./TagBrowser";
import WritingDashboard from "./WritingDashboard";

/** 선택된 메뉴의 대시보드: 타입별로 다른 화면을 보여준다 */
export default function Dashboard({
  noteType,
  compact = false,
}: {
  noteType: string;
  compact?: boolean;
}) {
  if (noteType === "home") return <HomeDashboard />;
  if (noteType === "book") return <Bookshelf compact={compact} />;
  if (noteType === "reading") return <ReadingDashboard />;
  if (noteType === "writing") return <WritingDashboard />;
  if (noteType === "tags") return <TagBrowser />;
  if (noteType === "audit") return <AuditDashboard />;
  return <ListDashboard noteType={noteType} />;
}

/** 독서기록 행: [[책제목]] → 책제목 */
function bookOf(n: NoteSummary): string {
  const link = fmStr(n, "book");
  const m = link.match(/\[\[([^\]|#]+)/);
  return m ? m[1].trim() : n.title;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** 제목을 미리 받지 않고 바로 만들어도 되는 타입.
 *  정보·자유노트는 생성 폼에 받을 게 사실상 없어서, 편집기에서 바로 쓰기 시작하는 편이 빠르다. */
const QUICK_CREATE = new Set(["free", "info"]);

function ListDashboard({ noteType }: { noteType: string }) {
  const { schemas, notes, current, openNote, openToday, createUntitled } =
    useVault();
  const [creating, setCreating] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  useCreateRequest(() => setCreating(true));
  const ctx = useContextMenu();
  const schema = schemas.find((s) => s.id === noteType);

  const all = useMemo(
    () => notes.filter((n) => n.note_type === noteType),
    [notes, noteType],
  );
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const n of all) for (const t of n.tags) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b, "ko"));
  }, [all]);
  const list = useMemo(
    () => (tagFilter ? all.filter((n) => n.tags.includes(tagFilter)) : all),
    [all, tagFilter],
  );

  // 데일리는 월별 그룹, 나머지는 단일 목록
  const groups = useMemo(() => {
    if (noteType !== "daily") return [["", list] as const];
    const map = new Map<string, NoteSummary[]>();
    for (const n of list) {
      const m = n.date.slice(0, 7) || "기타";
      map.set(m, [...(map.get(m) ?? []), n]);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [list, noteType]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-3">
        <h1 className="text-lg font-bold">
          {/* 일지는 오늘 노트가 본 화면이고 이 목록은 지난 것을 찾아보는 자리다 */}
          {noteType === "daily" ? "지난 일지" : (schema?.label ?? noteType)}{" "}
          <span className="text-sm font-normal text-neutral-400">
            {list.length}개
          </span>
        </h1>
        <button
          className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-white hover:bg-neutral-600"
          onClick={() => {
            if (noteType === "daily") openToday();
            else if (QUICK_CREATE.has(noteType)) createUntitled(noteType);
            else setCreating(true);
          }}
        >
          {noteType === "daily" ? "오늘의 노트" : "새로 만들기"}
        </button>
      </header>

      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-neutral-100 px-6 py-2">
          {allTags.map((t) => (
            <button
              key={t}
              className={`rounded-full px-2.5 py-0.5 text-xs ${
                tagFilter === t
                  ? "bg-violet-600 text-white"
                  : "bg-violet-50 text-violet-600 hover:bg-violet-100"
              }`}
              onClick={() => setTagFilter(tagFilter === t ? null : t)}
            >
              #{t}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {list.length === 0 && (
          <p className="mt-16 text-center text-sm text-neutral-400">
            아직 {schema?.label ?? noteType}가 없습니다. 오른쪽 위 버튼으로
            시작해 보세요.
          </p>
        )}
        {groups.map(([group, items]) => (
          <section key={group} className="mb-5">
            {group && (
              <h2 className="mb-2 text-sm font-semibold text-neutral-500">
                {group}
              </h2>
            )}
            <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white">
              {items.map((n) => (
                <li key={n.rel_path}>
                  <button
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-neutral-50 ${
                      current?.rel_path === n.rel_path ? "bg-neutral-100" : ""
                    }`}
                    {...noteItemHandlers(
                      n.rel_path,
                      () => openNote(n.rel_path),
                      openNoteWindow,
                      ctx.open,
                    )}
                  >
                    <Row note={n} noteType={noteType} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {creating && (
        <NewNoteDialog noteType={noteType} onClose={() => setCreating(false)} />
      )}
      {ctx.menu && <ContextMenu state={ctx.menu} onClose={ctx.close} />}
    </div>
  );
}

/** 목록용 제목 — 같은 제목이 여럿일 때 파일명에 붙은 꼬리표를 흐리게 보여 준다 */
function Title({ note, className }: { note: NoteSummary; className: string }) {
  const suffix = fileSuffix(note);
  return (
    <span className={className}>
      {note.title}
      {suffix && (
        <span className="ml-0.5 text-xs font-normal text-neutral-400">
          {suffix.trim()}
        </span>
      )}
    </span>
  );
}

function Row({ note, noteType }: { note: NoteSummary; noteType: string }) {
  const date = (
    <span className="w-24 shrink-0 text-xs text-neutral-400">{note.date}</span>
  );
  const tags = note.tags.length > 0 && (
    <span className="ml-auto flex shrink-0 gap-1">
      {note.tags.slice(0, 3).map((t) => (
        <span
          key={t}
          className="rounded bg-violet-50 px-1.5 py-0.5 text-2xs text-violet-600"
        >
          #{t}
        </span>
      ))}
    </span>
  );

  switch (noteType) {
    case "reading": {
      const author = fmStr(note, "author");
      return (
        <>
          {date}
          <span className="truncate text-sm font-medium">{bookOf(note)}</span>
          {author && (
            <span className="shrink-0 text-xs text-neutral-400">{author}</span>
          )}
          {tags}
        </>
      );
    }
    case "info": {
      const source = fmStr(note, "source");
      const host = hostOf(source);
      return (
        <>
          {date}
          <Title note={note} className="truncate text-sm" />
          {host && (
            <span className="shrink-0 rounded bg-sky-50 px-1.5 py-0.5 text-2xs text-sky-600">
              {host}
            </span>
          )}
          {tags}
        </>
      );
    }
    case "daily":
      return (
        <>
          <Title note={note} className="text-sm font-medium" />
          {tags}
        </>
      );
    default:
      return (
        <>
          {date}
          <Title note={note} className="truncate text-sm" />
          {tags}
        </>
      );
  }
}
