import { useEffect, useMemo, useState } from "react";
import type { NoteSummary } from "../bindings";
import { useVault } from "../stores/vault";
import { canMoveType, fileSuffix, fmDisplay, fmStr, josaRo, listFields } from "../lib/note";
import { useSelection } from "../lib/selection";
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
import SortControl, { useSort } from "./SortControl";
import { DATE_SORT, TITLE_SORT, sortNotes, type SortOption } from "../lib/sort";
import { groupNotes, groupOptions, normalizeGroup } from "../lib/group";
import { takeGroups, useIncremental } from "../lib/useIncremental";
import TagBrowser from "./TagBrowser";
import TodoDashboard from "./TodoDashboard";
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
  if (noteType === "todo") return <TodoDashboard />;
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
  const {
    schemas,
    notes,
    current,
    openNote,
    openToday,
    createUntitled,
    moveNoteTo,
    moveNotesTo,
    groupings,
    setGrouping,
  } = useVault();
  const [creating, setCreating] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [groupFilters, setGroupFilters] = useState<Record<string, string>>({});
  const [review, setReview] = useState(false);

  useCreateRequest(() => setCreating(true));
  // 필드 이름이 타입마다 달라 다른 분류로 넘어가면 걸어 둔 구분 필터를 씻어낸다
  useEffect(() => setGroupFilters({}), [noteType]);
  const ctx = useContextMenu();
  const schema = schemas.find((s) => s.id === noteType);
  // 줄 세울 수 있는 칸 — 날짜·제목에 더해, 고르는 칸(select)과 사람이 목록에
  // 보이기로 켠 칸까지. 화면에 안 보이는 칸으로 세우면 왜 이 차례인지 알 수 없다
  const sortOptions = useMemo<SortOption[]>(() => {
    const out: SortOption[] = [DATE_SORT, TITLE_SORT];
    const seen = new Set(["date", "title", "tags"]);
    for (const f of schema?.fields ?? []) {
      if (seen.has(f.name) || !(f.kind === "select" || f.in_list)) continue;
      seen.add(f.name);
      out.push({
        key: f.name,
        label: f.label,
        order: f.kind === "select" && f.options.length > 0 ? f.options : undefined,
        numeric: f.kind === "number",
      });
    }
    return out;
  }, [schema]);
  const [sort, setSort] = useSort(noteType, sortOptions);
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
    return sortNotes(out, sort, sortOptions);
  }, [all, tagFilter, groupFilters, sort, sortOptions]);

  // 묶어 보기 — 고른 것은 분류마다 기억한다. 일지는 처음부터 월별이다
  const groupOpts = useMemo(() => groupOptions(schema?.fields ?? []), [schema]);
  const groupKey = normalizeGroup(groupings[noteType], groupOpts, noteType);
  const groups = useMemo(
    () => groupNotes(list, groupKey, groupOpts),
    [list, groupKey, groupOpts],
  );
  // 수천 줄을 한꺼번에 그리지 않는다 — 앞의 몇백 줄만, 내려가면 더 (`useIncremental`).
  // 분류·묶기·정렬·필터가 바뀌면 처음 길이로 돌아간다
  const totalRows = useMemo(() => groups.reduce((n, [, items]) => n + items.length, 0), [groups]);
  const viewKey = `${noteType}|${groupKey}|${sort.key}|${sort.dir}|${tagFilter}|${JSON.stringify(groupFilters)}`;
  const rows = useIncremental(totalRows, viewKey);

  // 여러 줄 고르기 — 화면에 놓인 순서 그대로(아직 안 그린 줄까지) Shift 범위가 따라간다.
  // 분류·묶기·정렬·필터가 바뀌면 풀린다: 안 보이게 된 줄이 골라진 채 옮겨지면 안 된다.
  const order = useMemo(
    () => groups.flatMap(([, items]) => items.map((n) => n.rel_path)),
    [groups],
  );
  const sel = useSelection(order, viewKey);
  // 옮길 수 있는 분류에서만 고르기를 연다 (책·일지는 못 옮긴다 — 지금 고른 것으로 할 일이 이동뿐이다)
  const moveTargets = useMemo(
    () => (canMoveType(noteType) ? schemas.filter((s) => s.id !== noteType && canMoveType(s.id)) : []),
    [schemas, noteType],
  );
  const selectable = moveTargets.length > 0;
  const picking = sel.selected.size > 0;
  const moveSelected = (typeId: string) => {
    const rels = order.filter((rel) => sel.selected.has(rel));
    sel.clear();
    void moveNotesTo(rels, typeId);
  };
  const visibleGroups = useMemo(() => takeGroups(groups, rows.count), [groups, rows.count]);
  const groupSize = useMemo(() => new Map(groups.map(([k, items]) => [k, items.length])), [groups]);

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

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-neutral-100 px-6 py-1.5">
        <SortControl options={sortOptions} value={sort} onChange={setSort} />
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="mr-0.5 shrink-0 text-2xs text-neutral-400">묶기</span>
          {groupOpts.map((o) => (
            <button
              key={o.key}
              type="button"
              aria-pressed={groupKey === o.key}
              className={`shrink-0 rounded px-2 py-1 ${
                groupKey === o.key
                  ? "bg-neutral-200 text-neutral-800"
                  : "text-neutral-400 hover:bg-neutral-100"
              }`}
              title={o.key === "none" ? "묶지 않고 한 줄로" : `${o.label}(으)로 묶어 보기`}
              onClick={() => setGrouping(noteType, o.key)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

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

      {picking && (
        <SelectionBar count={sel.selected.size} targets={moveTargets} onMove={moveSelected} onClear={sel.clear} />
      )}

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {list.length === 0 && (
          <p className="mt-16 text-center text-sm text-neutral-400">
            아직 {schema?.label ?? noteType}가 없습니다. 오른쪽 위 버튼으로
            시작해 보세요.
          </p>
        )}
        {visibleGroups.map(([group, items]) => (
          <section key={group} className="mb-5">
            {group && (
              <h2 className="mb-2 text-sm font-semibold text-neutral-500">
                {group}{" "}
                {groupKey !== "none" && (
                  <span className="font-normal text-neutral-400">{groupSize.get(group)}</span>
                )}
                {selectable && picking && (
                  <GroupPick
                    rels={(groups.find(([k]) => k === group)?.[1] ?? []).map((n) => n.rel_path)}
                    selected={sel.selected}
                    onSet={sel.setMany}
                  />
                )}
              </h2>
            )}
            <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white">
              {items.map((n) => (
                <NoteLine
                  key={n.rel_path}
                  note={n}
                  open={current?.rel_path === n.rel_path}
                  selectable={selectable}
                  picking={picking}
                  picked={sel.selected.has(n.rel_path)}
                  onPick={sel.pick}
                  handlers={noteItemHandlers(
                    n.rel_path,
                    () => openNote(n.rel_path),
                    openNoteWindow,
                    ctx.open,
                    // 고른 줄을 우클릭하면 고른 것 전부를 옮긴다, 아니면 그 줄만
                    sel.selected.has(n.rel_path) && sel.selected.size > 1
                      ? [
                          { separator: true },
                          ...moveTargets.map((s) => ({
                            label: `${sel.selected.size}개를 ${s.label}${josaRo(s.label)} 이동`,
                            onClick: () => moveSelected(s.id),
                          })),
                        ]
                      : moveMenuItems(n.note_type, schemas, (id) => moveNoteTo(n.rel_path, id)),
                  )}
                >
                  <Row note={n} noteType={noteType} fields={shown} />
                </NoteLine>
              ))}
            </ul>
          </section>
        ))}
        {rows.more && <div ref={rows.sentinel} className="h-10" aria-hidden />}
      </div>

      {creating && (
        <NewNoteDialog noteType={noteType} onClose={() => setCreating(false)} />
      )}
      {ctx.menu && <ContextMenu state={ctx.menu} onClose={ctx.close} />}
    </div>
  );
}

/** 목록의 한 줄 — 왼쪽 체크 칸으로 여러 줄을 고른다.
 *
 *  체크 칸은 마우스를 올렸을 때, 그리고 하나라도 고른 뒤에는 늘 보인다. Shift를 누른 채
 *  줄이나 체크 칸을 누르면 마지막에 누른 줄부터 여기까지가 한꺼번에 골라진다.
 *  Ctrl+클릭은 건드리지 않는다 — 이미 "새 창으로 열기"다. */
function NoteLine({
  note,
  open,
  selectable,
  picking,
  picked,
  onPick,
  handlers,
  children,
}: {
  note: NoteSummary;
  open: boolean;
  selectable: boolean;
  picking: boolean;
  picked: boolean;
  onPick: (rel: string, shift: boolean) => void;
  handlers: ReturnType<typeof noteItemHandlers>;
  children: React.ReactNode;
}) {
  return (
    <li className={`group flex items-center ${picked ? "bg-sky-50" : open ? "bg-neutral-100" : ""}`}>
      {selectable && (
        <input
          type="checkbox"
          aria-label={`${note.title} 고르기`}
          title="고르기 — Shift를 누른 채 누르면 여기까지 한꺼번에"
          className={`ml-3 h-3.5 w-3.5 shrink-0 cursor-pointer accent-sky-600 ${
            picking ? "" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
          }`}
          checked={picked}
          // 값은 클릭에서 바꾼다 (Shift를 눌렀는지 알아야 한다)
          onChange={() => {}}
          onClick={(e) => onPick(note.rel_path, e.shiftKey)}
        />
      )}
      <button
        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left hover:bg-neutral-50"
        {...handlers}
        onClick={(e) => {
          // 고르는 중의 Shift+클릭은 열기가 아니라 범위 고르기다
          if (selectable && e.shiftKey) {
            e.preventDefault();
            onPick(note.rel_path, true);
            return;
          }
          handlers.onClick(e);
        }}
      >
        {children}
      </button>
    </li>
  );
}

/** 묶음 머리글의 "전부" — 그 묶음의 줄을 한꺼번에 고르거나 푼다 */
function GroupPick({
  rels,
  selected,
  onSet,
}: {
  rels: string[];
  selected: ReadonlySet<string>;
  onSet: (rels: string[], on: boolean) => void;
}) {
  const all = rels.length > 0 && rels.every((r) => selected.has(r));
  return (
    <button
      className="ml-2 rounded px-1.5 py-0.5 text-2xs font-normal text-sky-600 hover:bg-sky-50"
      onClick={() => onSet(rels, !all)}
    >
      {all ? "이 묶음 풀기" : "이 묶음 전부"}
    </button>
  );
}

/** 고른 줄이 있을 때 목록 위에 뜨는 띠 — 몇 개를 골랐는지, 무엇을 할 수 있는지 */
function SelectionBar({
  count,
  targets,
  onMove,
  onClear,
}: {
  count: number;
  targets: { id: string; label: string }[];
  onMove: (typeId: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center gap-2 border-b border-sky-200 bg-sky-50 px-6 py-1.5 text-sm">
      <span className="font-medium text-sky-800">{count}개 고름</span>
      <span className="relative">
        <button
          className="rounded border border-sky-300 bg-white px-2.5 py-1 text-xs text-sky-800 hover:border-sky-500"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          이동 ▾
        </button>
        {open && (
          <>
            {/* 바깥을 눌러 닫기 */}
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div className="absolute left-0 top-full z-50 mt-1 w-44 rounded-md border border-neutral-200 bg-white py-1 shadow-lg">
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
                  {josaRo(s.label)}
                </button>
              ))}
            </div>
          </>
        )}
      </span>
      <span className="flex-1" />
      <span className="text-2xs text-sky-700">Shift+클릭으로 범위 · Esc로 풀기</span>
      <button
        className="rounded px-2 py-1 text-xs text-sky-800 hover:bg-sky-100"
        onClick={onClear}
      >
        풀기
      </button>
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
