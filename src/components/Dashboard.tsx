import { useEffect, useMemo, useState } from "react";
import type { NoteSummary } from "../bindings";
import { useVault } from "../stores/vault";
import { fileSuffix, fmDisplay, fmStr, listFields } from "../lib/note";
import AuditDashboard from "./AuditDashboard";
import Bookshelf from "./Bookshelf";
import ContextMenu from "./ContextMenu";
import {
  moveMenuItems,
  noteItemHandlers,
  useContextMenu,
} from "../lib/contextMenu";
import { openNoteWindow } from "../lib/trashWindow";
import NewNoteDialog from "./NewNoteDialog";
import { useCreateRequest } from "../lib/shortcuts";
import HomeDashboard from "./HomeDashboard";
import ReadingDashboard from "./ReadingDashboard";
import ReviewDashboard from "./ReviewDashboard";
import ReviewModal from "./ReviewModal";
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
  if (noteType === "review") return <ReviewDashboard />;
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

/** 제목을 미리 받지 않고 바로 만들어도 되는 내장 타입.
 *  자유노트는 생성 폼에 받을 게 사실상 없어서, 편집기에서 바로 쓰기 시작하는 편이 빠르다.
 *  사용자 정의 타입도 마찬가지로 바로 시작한다 (아래 quickCreate 판정). */
const QUICK_CREATE = new Set(["free"]);

function ListDashboard({ noteType }: { noteType: string }) {
  const { schemas, notes, current, openNote, openToday, createUntitled, moveNoteTo } =
    useVault();
  const [creating, setCreating] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [groupFilters, setGroupFilters] = useState<Record<string, string>>({});
  const [review, setReview] = useState(false);

  useCreateRequest(() => setCreating(true));
  // 필드 이름이 타입마다 달라 다른 분류로 넘어가면 걸어 둔 구분 필터를 씻어낸다
  useEffect(() => setGroupFilters({}), [noteType]);
  const ctx = useContextMenu();
  const schema = schemas.find((s) => s.id === noteType);
  // 목록 줄에 값을 내보일 칸 (분류 설정에서 사람이 켠 것만)
  const shown = useMemo(() => listFields(schema), [schema]);
  // 사용자 정의 분류는 채울 필드를 스스로 정한 것이므로, 생성 폼 없이 바로 편집기로 시작한다
  const quickCreate = QUICK_CREATE.has(noteType) || (schema != null && !schema.builtin);

  const all = useMemo(
    () => notes.filter((n) => n.note_type === noteType),
    [notes, noteType],
  );
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const n of all) for (const t of n.tags) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b, "ko"));
  }, [all]);

  // select 필드마다 실제 쓰인 값들을 태그 칩처럼 필터로 보여준다
  const selectFields = useMemo(
    () => schema?.fields.filter((f) => f.kind === "select") ?? [],
    [schema],
  );
  const selectFieldValues = useMemo(() => {
    return selectFields.map((f) => {
      const set = new Set<string>();
      for (const n of all) {
        const v = fmStr(n, f.name);
        if (v) set.add(v);
      }
      return { field: f, values: [...set].sort((a, b) => a.localeCompare(b, "ko")) };
    });
  }, [all, selectFields]);

  const list = useMemo(() => {
    let out = tagFilter ? all.filter((n) => n.tags.includes(tagFilter)) : all;
    for (const [name, value] of Object.entries(groupFilters)) {
      out = out.filter((n) => fmStr(n, name) === value);
    }
    return out;
  }, [all, tagFilter, groupFilters]);

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
      {review && <ReviewModal onClose={() => setReview(false)} />}
      <header className="flex items-center gap-2 border-b border-neutral-200 px-6 py-3">
        <h1 className="text-lg font-bold">
          {/* 일지는 오늘 노트가 본 화면이고 이 목록은 지난 것을 찾아보는 자리다 */}
          {noteType === "daily" ? "지난 일지" : (schema?.label ?? noteType)}{" "}
          <span className="text-sm font-normal text-neutral-400">
            {list.length}개
          </span>
        </h1>
        <span className="flex-1" />
        {noteType === "daily" && (
          <button
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 hover:border-neutral-500 hover:text-neutral-900"
            onClick={() => setReview(true)}
            title="주간·월간으로 모아 보기"
          >
            🔭 회고
          </button>
        )}
        <button
          className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-white hover:bg-neutral-600"
          onClick={() => {
            if (noteType === "daily") openToday();
            else if (quickCreate) createUntitled(noteType);
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

      {selectFieldValues
        .filter(({ values }) => values.length > 0)
        .map(({ field, values }) => (
          <div
            key={field.name}
            className="flex flex-wrap items-center gap-1.5 border-b border-neutral-100 px-6 py-2"
          >
            <span className="text-2xs text-neutral-400">{field.label}</span>
            {values.map((v) => (
              <button
                key={v}
                className={`rounded-full px-2.5 py-0.5 text-xs ${
                  groupFilters[field.name] === v
                    ? "bg-sky-600 text-white"
                    : "bg-sky-50 text-sky-600 hover:bg-sky-100"
                }`}
                onClick={() =>
                  setGroupFilters((f) => {
                    const next = { ...f };
                    if (next[field.name] === v) delete next[field.name];
                    else next[field.name] = v;
                    return next;
                  })
                }
              >
                {v}
              </button>
            ))}
          </div>
        ))}

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
                      moveMenuItems(n.note_type, schemas, (id) =>
                        moveNoteTo(n.rel_path, id),
                      ),
                    )}
                  >
                    <Row note={n} noteType={noteType} fields={shown} />
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

function Row({
  note,
  noteType,
  fields = [],
}: {
  note: NoteSummary;
  noteType: string;
  /** 분류 정의에서 '목록에 보이기'를 켠 칸들 — 제목 뒤에 뱃지로 붙는다 */
  fields?: { name: string; label: string }[];
}) {
  const date = (
    <span className="w-24 shrink-0 text-xs text-neutral-400">{note.date}</span>
  );
  // 켠 칸이라도 값이 빈 노트에는 빈 뱃지를 만들지 않는다
  const extras = fields
    .map((f) => ({ field: f, value: fmDisplay(note, f.name) }))
    .filter(({ value }) => value !== "")
    .map(({ field, value }) => (
      <span
        key={field.name}
        className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-2xs text-neutral-500"
        title={field.label}
      >
        {value}
      </span>
    ));
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
    case "daily":
      return (
        <>
          <Title note={note} className="text-sm font-medium" />
          {tags}
        </>
      );
    default: {
      // source 필드(스크랩 등)가 있으면 출처 배지를 붙인다 — 특정 타입 전용이 아니다
      const host = hostOf(fmStr(note, "source"));
      return (
        <>
          {date}
          <Title note={note} className="truncate text-sm" />
          {extras}
          {host && (
            <span className="shrink-0 rounded bg-sky-50 px-1.5 py-0.5 text-2xs text-sky-600">
              {host}
            </span>
          )}
          {tags}
        </>
      );
    }
  }
}
