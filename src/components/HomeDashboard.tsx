import { useEffect, useMemo, useState } from "react";
import { typeLabel, useVault } from "../stores/vault";
import { fmStr } from "../lib/note";
import {
  moveMenuItems,
  noteItemHandlers,
  useContextMenu,
} from "../lib/contextMenu";
import { openNoteWindow } from "../lib/trashWindow";
import ContextMenu from "./ContextMenu";

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 홈: 독서·쓰기 통계 + 데일리 히트맵 + 최근 활동 */
export default function HomeDashboard() {
  const {
    notes,
    schemas,
    todos,
    todoOpenTotal,
    todoTabOn,
    openNote,
    openToday,
    setNav,
    moveNoteTo,
    refreshTodos,
    toggleTodoItem,
  } = useVault();
  const ctx = useContextMenu();
  const year = new Date().getFullYear();

  /** 목록 항목 공통: 클릭=열기, Ctrl+클릭·가운데클릭=새 창, 우클릭=메뉴(+분류 이동) */
  const itemProps = (rel: string) => {
    const noteType = notes.find((n) => n.rel_path === rel)?.note_type ?? "";
    return noteItemHandlers(
      rel,
      () => openNote(rel),
      openNoteWindow,
      ctx.open,
      moveMenuItems(noteType, schemas, (id) => moveNoteTo(rel, id)),
    );
  };

  const stats = useMemo(() => {
    const books = notes.filter((n) => n.note_type === "book");
    const readingNow = books.filter((b) => fmStr(b, "status") === "reading");
    const finishedThisYear = books.filter(
      (b) =>
        fmStr(b, "status") === "finished" &&
        (fmStr(b, "finished").startsWith(String(year)) ||
          (!fmStr(b, "finished") && b.date.startsWith(String(year)))),
    );
    const wishlist = books.filter((b) => fmStr(b, "status") === "wishlist");

    const pieces = notes.filter((n) => n.note_type === "writing");
    const inProgress = pieces.filter((p) =>
      ["draft", "revise"].includes(fmStr(p, "status")),
    );
    const doneCount = pieces.filter((p) => fmStr(p, "status") === "done").length;
    const totalChars = pieces.reduce((s, p) => s + p.char_count, 0);

    return {
      bookTotal: books.length,
      readingNow,
      finishedThisYear: finishedThisYear.length,
      wishlist: wishlist.length,
      pieces: pieces.length,
      inProgress,
      doneCount,
      totalChars,
    };
  }, [notes, year]);

  // 데일리 히트맵: 최근 16주 (일요일 시작 열 단위)
  const heatmap = useMemo(() => {
    const dailyDates = new Set(
      notes.filter((n) => n.note_type === "daily").map((n) => n.date),
    );
    const today = new Date();
    const cells: { date: string; has: boolean }[] = [];
    const start = new Date(today);
    start.setDate(start.getDate() - (16 * 7 - 1) - today.getDay());
    for (let i = 0; i < 16 * 7 + today.getDay() + 1; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      if (d > today) break;
      const iso = isoDate(d);
      cells.push({ date: iso, has: dailyDates.has(iso) });
    }
    return cells;
  }, [notes]);

  const streak = useMemo(() => {
    const dailyDates = new Set(
      notes.filter((n) => n.note_type === "daily").map((n) => n.date),
    );
    let count = 0;
    const d = new Date();
    // 오늘 안 썼으면 어제부터 계산
    if (!dailyDates.has(isoDate(d))) d.setDate(d.getDate() - 1);
    while (dailyDates.has(isoDate(d))) {
      count += 1;
      d.setDate(d.getDate() - 1);
    }
    return count;
  }, [notes]);

  const recent = useMemo(() => notes.slice(0, 8), [notes]);

  // 미완 할 일 (데일리 우선). 목록은 스토어가 한 벌만 들고 있다 —
  // 홈에 들어올 때 한 번 다시 읽어, 편집기에서 손으로 적은 체크박스도 따라온다
  useEffect(() => {
    refreshTodos();
  }, [refreshTodos]);
  const [togglingTodo, setTogglingTodo] = useState<string | null>(null);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b border-neutral-200 px-6 py-3">
        <h1 className="text-lg font-bold">홈</h1>
      </header>

      <div className="grid gap-4 p-6 lg:grid-cols-2">
        {/* 독서 카드 */}
        <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold">📚 독서</h2>
            <button
              className="text-xs text-neutral-400 hover:text-neutral-600"
              onClick={() => setNav("book")}
            >
              책장 열기 →
            </button>
          </div>
          <div className="mb-3 grid grid-cols-3 gap-2 text-center">
            <Stat label={`${year}년 완독`} value={stats.finishedThisYear} />
            <Stat label="읽는 중" value={stats.readingNow.length} />
            <Stat label="읽고 싶은 책" value={stats.wishlist} />
          </div>
          {stats.readingNow.length > 0 && (
            <ul className="flex flex-col gap-1">
              {stats.readingNow.slice(0, 4).map((b) => (
                <li key={b.rel_path}>
                  <button
                    className="w-full truncate rounded px-2 py-1 text-left text-xs text-neutral-600 hover:bg-neutral-50"
                    {...itemProps(b.rel_path)}
                  >
                    📖 {b.title}
                    {fmStr(b, "author") && (
                      <span className="text-neutral-400"> · {fmStr(b, "author")}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 쓰기 카드 */}
        <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold">✍️ 쓰기</h2>
            <button
              className="text-xs text-neutral-400 hover:text-neutral-600"
              onClick={() => setNav("writing")}
            >
              글쓰기 열기 →
            </button>
          </div>
          <div className="mb-3 grid grid-cols-3 gap-2 text-center">
            <Stat label="전체 원고" value={stats.pieces} />
            <Stat label="완성" value={stats.doneCount} />
            <Stat
              label="총 글자수"
              value={stats.totalChars.toLocaleString()}
              small
            />
          </div>
          {stats.inProgress.length > 0 && (
            <ul className="flex flex-col gap-1">
              {stats.inProgress.slice(0, 4).map((p) => (
                <li key={p.rel_path}>
                  <button
                    className="w-full truncate rounded px-2 py-1 text-left text-xs text-neutral-600 hover:bg-neutral-50"
                    {...itemProps(p.rel_path)}
                  >
                    ✏️ {p.title}
                    <span className="text-neutral-400">
                      {" "}
                      · {p.char_count.toLocaleString()}자
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 할 일 — 여기서 바로 체크할 수 있다. 홈에 띄워 두고 하루를 보내는
            화면이라, 끝낸 것을 표시하러 그 글까지 들어갈 이유가 없다 */}
        <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold">
              ☑ 할 일{" "}
              {todoOpenTotal > 0 && (
                <span className="ml-1 text-xs font-normal text-amber-600">
                  {todoOpenTotal}건
                </span>
              )}
            </h2>
            <button
              className="text-xs text-neutral-400 hover:text-neutral-600"
              onClick={() => (todoTabOn ? setNav("todo") : openToday())}
            >
              {todoTabOn ? "할 일 모아보기 →" : "오늘 노트 →"}
            </button>
          </div>
          {todos.length === 0 ? (
            <p className="py-4 text-center text-xs text-neutral-400">
              끝내지 않은 할 일이 없습니다
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {todos.slice(0, 8).map((t) => {
                const key = `${t.rel_path}#${t.index}`;
                return (
                  <li
                    key={key}
                    className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-neutral-50"
                  >
                    <button
                      className="shrink-0 text-neutral-300 hover:text-emerald-500 disabled:opacity-50"
                      disabled={togglingTodo !== null}
                      title="완료 표시"
                      onClick={async () => {
                        setTogglingTodo(key);
                        try {
                          await toggleTodoItem(t);
                        } finally {
                          setTogglingTodo(null);
                        }
                      }}
                    >
                      ☐
                    </button>
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2 rounded text-left"
                      {...itemProps(t.rel_path)}
                      title={`${t.note_title} 에서 열기`}
                    >
                      <span className="truncate text-neutral-700">{t.text}</span>
                      <span className="ml-auto shrink-0 text-3xs text-neutral-400">
                        {t.note_type === "daily" ? t.date : t.note_title}
                      </span>
                    </button>
                  </li>
                );
              })}
              {todoOpenTotal > 8 && (
                <li className="px-2 pt-1 text-3xs text-neutral-400">
                  외 {todoOpenTotal - 8}건
                </li>
              )}
            </ul>
          )}
        </section>

        {/* 데일리 히트맵 */}
        <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold">
              📅 데일리{" "}
              {streak > 0 && (
                <span className="ml-1 text-xs font-normal text-amber-600">
                  🔥 {streak}일 연속
                </span>
              )}
            </h2>
            <button
              className="rounded bg-neutral-800 px-2.5 py-1 text-xs text-white hover:bg-neutral-600"
              onClick={openToday}
            >
              오늘 쓰기
            </button>
          </div>
          <div className="grid grid-flow-col grid-rows-7 gap-[3px]">
            {heatmap.map((c) => (
              <div
                key={c.date}
                title={c.date}
                className={`h-3 w-3 rounded-[3px] ${
                  c.has ? "bg-emerald-500" : "bg-neutral-100"
                }`}
              />
            ))}
          </div>
          <p className="mt-2 text-3xs text-neutral-400">최근 16주</p>
        </section>

        {/* 최근 활동 */}
        <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-bold">🕘 최근 노트</h2>
          <ul className="flex flex-col gap-0.5">
            {recent.map((n) => (
              <li key={n.rel_path}>
                <button
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-neutral-50"
                  {...itemProps(n.rel_path)}
                >
                  <span className="w-16 shrink-0 rounded bg-neutral-100 px-1 py-0.5 text-center text-3xs text-neutral-500">
                    {typeLabel(schemas, n.note_type)}
                  </span>
                  <span className="truncate text-neutral-700">{n.title}</span>
                  <span className="ml-auto shrink-0 text-3xs text-neutral-400">
                    {n.date}
                  </span>
                </button>
              </li>
            ))}
            {recent.length === 0 && (
              <p className="py-4 text-center text-xs text-neutral-400">
                아직 노트가 없습니다
              </p>
            )}
          </ul>
        </section>
      </div>

      {ctx.menu && <ContextMenu state={ctx.menu} onClose={ctx.close} />}
    </div>
  );
}

function Stat({
  label,
  value,
  small = false,
}: {
  label: string;
  value: number | string;
  small?: boolean;
}) {
  return (
    <div className="rounded-lg bg-neutral-50 py-2">
      <p className={`font-bold ${small ? "text-sm" : "text-xl"}`}>{value}</p>
      <p className="text-3xs text-neutral-400">{label}</p>
    </div>
  );
}
