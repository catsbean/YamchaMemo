import { useEffect, useMemo, useState } from "react";
import { commands, type NoteTodo, type ReviewRange } from "../bindings";
import { kindByLabel, styleOf } from "../lib/callouts";
import { weekdayOf, ymd } from "../lib/date";
import { bodyToHtml, wrapDocument } from "../lib/exportHtml";
import { printHtml, saveTextAs } from "../lib/exportFile";
import {
  cardOfReading,
  cardsOfDay,
  DEFAULT_FILTER,
  filterCards,
  filterTodos,
  groupByDate,
  hasCardFilter,
  rangeOf,
  stepRange,
  type ReviewCard,
  type ReviewFilter,
  type Span,
} from "../lib/reviewFilter";
import { useVault } from "../stores/vault";
import NoteText from "./NoteText";

/** 화면에 그릴 날짜 한 칸 */
interface Section {
  date: string;
  /** 그 날 일지 경로 (독서기록만 있는 날은 빈 문자열) */
  rel: string;
  cards: ReviewCard[];
  todos: NoteTodo[];
}

const EMPTY: ReviewRange = { days: [], reading: [] };

/** 주간·월간 회고 — 여러 날의 기록과 할 일을 한 화면에 모아 본다.
 *
 *  일지는 하루 단위로 쓰지만 돌아볼 때는 주·월 단위로 본다. 날짜를 하나씩
 *  열어 가며 훑는 대신 한 번에 펼쳐 놓는다. */
export default function ReviewDashboard() {
  const openNote = useVault((s) => s.openNote);
  const callouts = useVault((s) => s.callouts);
  /** 독서기록도 함께 볼지 (설정에 남는다) */
  const showReading = useVault((s) => s.reviewShowReading);
  const toggleReading = useVault((s) => s.toggleReviewShowReading);

  const [span, setSpan] = useState<Span>("week");
  /** 기준점 — 이 날이 속한 주/달을 본다 */
  const [anchor, setAnchor] = useState(() => ymd(new Date()));
  const [custom, setCustom] = useState(() => {
    const today = ymd(new Date());
    return { from: today, to: today };
  });
  const [filter, setFilter] = useState<ReviewFilter>(DEFAULT_FILTER);
  const [data, setData] = useState<ReviewRange | null>(null);

  const range = useMemo(
    () => rangeOf(span, anchor, custom),
    [span, anchor, custom],
  );
  const { from, to, label } = range;

  // 기간 전체를 한 번에 받는다. 좁히는 일은 전부 아래에서 — 칩 하나 누를 때마다
  // 파일을 다시 읽을 이유가 없다.
  //
  // 스토어의 `notes`를 보지 않는 것이 중요하다. 일지를 자동저장할 때마다 그 배열의
  // 신원이 바뀌는데, 그걸 의존성에 넣으면 회고가 몇 초마다 기간 전체를 다시 읽는다.
  useEffect(() => {
    if (from > to) {
      setData(EMPTY);
      return;
    }
    let alive = true;
    setData(null);
    commands.reviewRange(from, to, showReading).then((r) => {
      if (!alive) return;
      setData(r.status === "ok" ? r.data : EMPTY);
    });
    return () => {
      alive = false;
    };
  }, [from, to, showReading]);

  const shift = (by: number) => {
    const next = stepRange(span, anchor, custom, by);
    setAnchor(next.anchor);
    setCustom(next.custom);
  };

  /** 기간 안의 모든 카드 (일지 기록 + 독서기록). 필터를 걸기 전 모수다 */
  const allCards = useMemo(
    () =>
      data
        ? [...data.days.flatMap(cardsOfDay), ...data.reading.map(cardOfReading)]
        : [],
    [data],
  );

  const shown = useMemo(() => filterCards(allCards, filter), [allCards, filter]);

  const sections = useMemo<Section[]>(() => {
    if (!data) return [];
    const relOf = new Map(data.days.map((d) => [d.date, d.rel_path]));
    const todosOf = new Map(
      data.days.map((d) => [d.date, filterTodos(d.todos, d.date, filter)]),
    );
    const cardsOf = new Map(
      groupByDate(shown, filter).map((g) => [g.date, g.cards]),
    );

    const dates = new Set<string>(cardsOf.keys());
    // 필터가 없으면 할 일만 적은 날도 그대로 보여 준다 (예전부터 그랬다).
    // 필터가 걸렸을 때만 "조건에 맞는 게 없는 날"로 보고 접는다.
    if (!hasCardFilter(filter))
      for (const [d, ts] of todosOf) if (ts.length > 0) dates.add(d);

    return [...dates]
      .sort((a, b) =>
        filter.order === "old" ? a.localeCompare(b) : b.localeCompare(a),
      )
      .map((date) => ({
        date,
        rel: relOf.get(date) ?? "",
        cards: cardsOf.get(date) ?? [],
        todos: todosOf.get(date) ?? [],
      }));
  }, [data, shown, filter]);

  const stat = useMemo(() => {
    const todos = sections.flatMap((s) => s.todos);
    // 종류 칩의 개수는 **거르기 전** 기준이다 — 거른 뒤로 세면 고른 종류만
    // 남고 나머지 칩이 사라져 되돌릴 수가 없다
    const byKind = new Map<string, number>();
    for (const c of allCards)
      byKind.set(c.kindLabel, (byKind.get(c.kindLabel) ?? 0) + 1);
    return {
      일수: sections.length,
      기록: shown.length,
      전체기록: allCards.length,
      끝낸할일: todos.filter((t) => t.done).length,
      남은할일: todos.filter((t) => !t.done).length,
      종류별: [...byKind.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [sections, shown, allCards]);

  const kindOf = (labelName: string) =>
    kindByLabel(
      labelName,
      callouts.map((c) => ({
        label: c.label,
        icon: c.icon ?? "",
        color: c.color as never,
      })),
    );

  const toggleKind = (k: string) =>
    setFilter((f) => ({
      ...f,
      kinds: f.kinds.includes(k)
        ? f.kinds.filter((x) => x !== k)
        : [...f.kinds, k],
    }));

  /** 지금 보고 있는 회고를 문서 한 장으로 */
  function buildHtml(): string {
    const md = sections
      .map((s) => {
        const head = `## ${s.date} (${weekdayOf(s.date)})`;
        const todo = s.todos
          .map((t) => `- [${t.done ? "x" : " "}] ${t.text}`)
          .join("\n");
        const rec = s.cards
          .map(
            (c) =>
              `> [!${c.kindLabel}] ${c.time || c.date}\n> ${c.text.split("\n").join("\n> ")}`,
          )
          .join("\n\n");
        return [head, todo, rec].filter(Boolean).join("\n\n");
      })
      .join("\n\n");
    const meta = `${label} · 기록 ${stat.기록}건 · 끝낸 할 일 ${stat.끝낸할일}건`;
    return wrapDocument(`회고 ${label}`, bodyToHtml(md), meta);
  }

  const loading = data === null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-6 py-3">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold">회고</h1>
          <div className="flex gap-1 text-xs">
            {(
              [
                ["week", "주간"],
                ["month", "월간"],
              ] as const
            ).map(([v, t]) => (
              <button
                key={v}
                className={`rounded px-2.5 py-1 ${
                  span === v
                    ? "bg-neutral-800 text-white"
                    : "text-neutral-500 hover:bg-neutral-100"
                }`}
                onClick={() => setSpan(v)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
            onClick={() => shift(-1)}
            title="이전"
          >
            ◀
          </button>
          <span className="min-w-40 text-center text-sm font-medium">{label}</span>
          <button
            className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
            onClick={() => shift(1)}
            title="다음"
          >
            ▶
          </button>
          <button
            className="ml-1 rounded border border-neutral-300 px-2 py-1 text-2xs text-neutral-500 hover:border-neutral-500"
            onClick={() => setAnchor(ymd(new Date()))}
          >
            이번 {span === "week" ? "주" : "달"}
          </button>
          <button
            className={`ml-2 rounded-full border px-2.5 py-1 text-xs ${
              showReading
                ? "border-transparent bg-amber-600 text-white"
                : "border-neutral-300 text-neutral-600 hover:bg-neutral-100"
            }`}
            onClick={() => toggleReading()}
            title="책에 남긴 발췌·생각·요약·질문도 날짜별로 함께 봅니다"
          >
            📖 독서기록
          </button>
          <button
            className="rounded border border-neutral-300 px-2.5 py-1 text-xs text-neutral-600 hover:border-neutral-500 disabled:opacity-40"
            disabled={sections.length === 0}
            onClick={() => printHtml(buildHtml())}
            title="인쇄 창에서 PDF로 저장할 수 있습니다"
          >
            🖨️ 인쇄
          </button>
          <button
            className="rounded border border-neutral-300 px-2.5 py-1 text-xs text-neutral-600 hover:border-neutral-500 disabled:opacity-40"
            disabled={sections.length === 0}
            onClick={() => saveTextAs(`회고 ${label}`, "html", "HTML 문서", buildHtml())}
          >
            ⬇ HTML
          </button>
        </div>
      </header>

      {/* 기간 집계 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-neutral-100 px-6 py-2 text-xs text-neutral-500">
        <span>
          쓴 날 <b className="text-neutral-800">{stat.일수}</b>일
        </span>
        <span>
          기록 <b className="text-neutral-800">{stat.기록}</b>건
          {stat.기록 !== stat.전체기록 && (
            <span className="ml-1 text-neutral-400">(전체 {stat.전체기록}건 중)</span>
          )}
        </span>
        <span>
          끝낸 할 일 <b className="text-emerald-600">{stat.끝낸할일}</b>
        </span>
        <span>
          남은 할 일 <b className="text-neutral-800">{stat.남은할일}</b>
        </span>
        {stat.종류별.length > 0 && (
          <span className="ml-auto flex flex-wrap gap-1">
            {stat.종류별.map(([kind, n]) => {
              const k = kindOf(kind);
              // 아무것도 안 고른 상태가 "전부 보기"다
              const on = filter.kinds.length === 0 || filter.kinds.includes(kind);
              return (
                <button
                  key={kind}
                  className={`rounded-full border border-current/10 px-2 py-0.5 ${
                    on ? styleOf(k.color).active : "bg-neutral-100 text-neutral-400"
                  }`}
                  onClick={() => toggleKind(kind)}
                  title="이 종류만 보기"
                >
                  {k.icon} {kind} {n}
                </button>
              );
            })}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading && (
          <p className="mt-16 text-center text-sm text-neutral-400">불러오는 중…</p>
        )}
        {!loading && from > to && (
          <p className="mt-16 text-center text-sm text-neutral-400">
            시작이 끝보다 뒤입니다 — 기간을 다시 골라 주세요.
          </p>
        )}
        {!loading && from <= to && sections.length === 0 && (
          <p className="mt-16 text-center text-sm text-neutral-400">
            이 {span === "month" ? "달" : "기간"}에는 쓴 것이 없습니다.
          </p>
        )}
        {!loading &&
          sections.map((s) => (
            <section key={s.date} className="mb-6">
              <button
                className="mb-2 flex items-baseline gap-2 rounded px-1 hover:bg-neutral-100 disabled:hover:bg-transparent"
                disabled={!s.rel}
                onClick={() => s.rel && openNote(s.rel)}
                title={s.rel ? "이 날 일지 열기" : "이 날은 일지가 없습니다"}
              >
                <h2 className="text-sm font-bold">{s.date}</h2>
                <span className="text-2xs text-neutral-400">({weekdayOf(s.date)})</span>
                {s.todos.some((t) => t.done) && (
                  <span className="text-2xs text-emerald-600">
                    ✅ {s.todos.filter((t) => t.done).length}
                  </span>
                )}
              </button>

              {s.todos.length > 0 && (
                <ul className="mb-2 flex flex-col gap-0.5">
                  {[...s.todos].sort((a, b) => Number(a.done) - Number(b.done)).map((t) => (
                    <li key={t.index} className="flex gap-1.5 text-sm">
                      <span className={t.done ? "text-emerald-600" : "text-neutral-400"}>
                        {t.done ? "☑" : "☐"}
                      </span>
                      <span
                        className={
                          t.done ? "text-neutral-400 line-through" : "text-neutral-800"
                        }
                      >
                        {t.text}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex flex-col gap-1.5">
                {s.cards.map((c, i) => {
                  const k = kindOf(c.kindLabel);
                  const head = (
                    <div className="mb-0.5 flex items-baseline gap-1.5 text-2xs">
                      {c.source === "book" && (
                        <span className="rounded bg-amber-100 px-1 text-amber-700">
                          📖 {c.bookTitle}
                        </span>
                      )}
                      <span className="font-semibold opacity-70">
                        {k.icon} {c.kindLabel}
                      </span>
                      {c.time && <span className="opacity-70">{c.time}</span>}
                    </div>
                  );
                  const body = (
                    <NoteText text={c.text} className="whitespace-pre-wrap text-sm" />
                  );
                  const cls = `rounded-md border px-3 py-2 ${styleOf(k.color).card}`;
                  // 독서기록은 누르면 그 책으로 간다 — 일지 기록은 위 날짜 단추가 그 일을 한다
                  return c.source === "book" ? (
                    <button
                      key={i}
                      className={`${cls} text-left`}
                      onClick={() => openNote(c.rel)}
                      title="이 책 열기"
                    >
                      {head}
                      {body}
                    </button>
                  ) : (
                    <div key={i} className={cls}>
                      {head}
                      {body}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
      </div>
    </div>
  );
}
