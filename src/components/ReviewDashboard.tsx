import { useEffect, useMemo, useState } from "react";
import { commands, type NoteTodo, type ReviewRange } from "../bindings";
import { kindByLabel, styleOf } from "../lib/callouts";
import { addDays, daysBetween, weekdayOf, ymd } from "../lib/date";
import { wrapDocument } from "../lib/exportHtml";
import { printHtml, saveTextAs } from "../lib/exportFile";
import { buildReviewDoc } from "../lib/exportReview";
import { useContextMenu, type MenuItem } from "../lib/contextMenu";
import {
  cardOfReading,
  cardsOfDay,
  clearFilter,
  DEFAULT_FILTER,
  filterCards,
  filterCount,
  filterTodos,
  groupByDate,
  hasCardFilter,
  rangeFileLabel,
  rangeOf,
  stepRange,
  type ReviewCard,
  type ReviewFilter,
  type Span,
} from "../lib/reviewFilter";
import { useVault } from "../stores/vault";
import ContextMenu from "./ContextMenu";
import NoteText from "./NoteText";
import ReviewFilterPanel from "./ReviewFilterPanel";
import Segmented from "./Segmented";

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
  const setShowReading = useVault((s) => s.setReviewShowReading);
  const savedFilter = useVault((s) => s.reviewLastFilter);
  const setSavedFilter = useVault((s) => s.setReviewLastFilter);

  const [span, setSpan] = useState<Span>("week");
  /** 기준점 — 이 날이 속한 주/달을 본다 */
  const [anchor, setAnchor] = useState(() => ymd(new Date()));
  const [custom, setCustom] = useState(() => {
    const today = ymd(new Date());
    return { from: addDays(today, -13), to: today };
  });
  /** 필터는 열 때마다 비어 있다 — 어제 걸어 둔 조건 때문에 기록이 안 보이는
   *  일이 없도록. 대신 마지막 조합을 설정에 남겨 "↺ 마지막 필터"로 되부른다.
   *  출처만은 설정을 따른다 (책을 안 보는 사람이 매번 책 폴더를 훑지 않도록) */
  const [filter, setFilter] = useState<ReviewFilter>(() => ({
    ...DEFAULT_FILTER,
    source: useVault.getState().reviewShowReading ? "all" : "daily",
  }));
  const [data, setData] = useState<ReviewRange | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

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
  /** 일지만 보기로 좁혔으면 책 폴더는 아예 훑지 않는다 */
  const withReading = filter.source !== "daily";

  useEffect(() => {
    if (from > to) {
      setData(EMPTY);
      return;
    }
    let alive = true;
    setData(null);
    commands.reviewRange(from, to, withReading).then((r) => {
      if (!alive) return;
      setData(r.status === "ok" ? r.data : EMPTY);
    });
    return () => {
      alive = false;
    };
  }, [from, to, withReading]);

  // 다음에 회고를 열 때의 기본이 된다
  useEffect(() => {
    void setShowReading(withReading);
  }, [withReading, setShowReading]);

  // 지금 건 조건을 설정에 남긴다 — 다음에 "↺ 마지막 필터"로 되부를 수 있게.
  // 늦게 쓰는 이유는 autoSave 저장소라서다. 그대로 두면 포함어를 칠 때
  // 글자마다 settings.json이 디스크에 쓰인다.
  useEffect(() => {
    if (filterCount(filter) === 0) return; // 빈 필터는 되부를 값이 없다
    const t = setTimeout(() => void setSavedFilter(filter), 400);
    return () => clearTimeout(t);
  }, [filter, setSavedFilter]);

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

  const kindOf = (labelName: string) => kindByLabel(labelName, callouts);

  const activeCount = filterCount(filter);

  /** 주·달 ↔ 기간 지정 갈아타기.
   *
   *  주·달에서 넘어올 때만 지금 보던 기간을 물려준다 — 갈아타자마자 엉뚱한 날로
   *  튀면 어디를 보고 있었는지 잃는다. 이미 기간 지정이면 손대지 않는다.
   *  프리셋("최근 7일")은 기간을 먼저 넣고 span을 바꾸는데, 여기서 무조건
   *  덮어쓰면 방금 넣은 값이 도로 지워진다. */
  const chooseSpan = (v: Span) => {
    if (v === "custom" && span !== "custom") setCustom({ from, to });
    setSpan(v);
  };

  const exportMenu = useContextMenu();

  /** 지금 화면에 보이는 회고를 그대로 문서로 — 필터가 곧 내보낼 범위다 */
  function reviewDoc() {
    const d = buildReviewDoc(sections, { label, filter }, callouts);
    return { ...d, wrapped: wrapDocument(d.title, d.html, d.meta, callouts) };
  }

  const fileName = `회고 ${rangeFileLabel(range)}`;
  const exportItems: MenuItem[] = [
    {
      label: "🖨️ 인쇄 · PDF로 저장",
      hint: "인쇄 창에서 PDF 선택",
      onClick: () => printHtml(reviewDoc().wrapped),
    },
    {
      label: "📄 텍스트로 저장",
      hint: "글자만 — 어디에나 붙여넣기",
      onClick: () => void saveTextAs(fileName, "txt", "텍스트", reviewDoc().text),
    },
    {
      label: "🖼️ HTML로 저장",
      hint: "스타일까지 한 파일",
      onClick: () =>
        void saveTextAs(fileName, "html", "HTML 문서", reviewDoc().wrapped),
    },
  ];

  const loading = data === null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-6 py-3">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold">회고</h1>
          <Segmented
            value={span}
            options={
              [
                ["week", "주간"],
                ["month", "월간"],
                ["custom", "기간 지정"],
              ] as const
            }
            onChange={chooseSpan}
          />
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
            onClick={() => {
              const today = ymd(new Date());
              if (span === "custom") {
                // 폭은 그대로 두고 오늘까지 당긴다
                const n = Math.max(1, daysBetween(custom.from, custom.to));
                setCustom({ from: addDays(today, -(n - 1)), to: today });
              } else setAnchor(today);
            }}
          >
            {span === "month" ? "이번 달" : span === "week" ? "이번 주" : "오늘까지"}
          </button>
          <button
            className={`ml-2 rounded-full border px-2.5 py-1 text-xs ${
              panelOpen || activeCount > 0
                ? "border-transparent bg-neutral-800 text-white"
                : "border-neutral-300 text-neutral-600 hover:bg-neutral-100"
            }`}
            onClick={() => setPanelOpen((v) => !v)}
            title="종류·태그·말·요일·시간대로 좁혀 봅니다"
          >
            🔎 필터{activeCount > 0 && ` ${activeCount}`}
          </button>
          <button
            className="rounded border border-neutral-300 px-2.5 py-1 text-xs text-neutral-600 hover:border-neutral-500 disabled:opacity-40"
            disabled={shown.length === 0 && sections.length === 0}
            onClick={(ev) => {
              const r = ev.currentTarget.getBoundingClientRect();
              exportMenu.open(
                { clientX: r.right - 180, clientY: r.bottom + 2, preventDefault: () => {} },
                exportItems,
              );
            }}
            title="지금 화면에 보이는 것을 그대로 문서로 냅니다"
          >
            ⬇ 내보내기
          </button>
        </div>
      </header>

      <ReviewFilterPanel
        open={panelOpen}
        filter={filter}
        setFilter={setFilter}
        span={span}
        setSpan={chooseSpan}
        custom={custom}
        setCustom={setCustom}
        cards={allCards}
        kindOf={kindOf}
        saved={savedFilter}
        onLoadSaved={() => savedFilter && setFilter(savedFilter)}
      />

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
          <div className="mt-16 text-center text-sm text-neutral-400">
            {activeCount === 0 ? (
              <>
                <p>이 {span === "month" ? "달" : "기간"}에는 쓴 것이 없습니다.</p>
                <p className="mt-1 text-xs">
                  콜아웃으로 남기지 않은 원문은 기록으로 세지 않습니다.
                </p>
              </>
            ) : (
              <>
                <p className="text-neutral-500">필터에 걸린 기록이 없습니다.</p>
                <p className="mt-1 text-xs">
                  필터 {activeCount}개가 걸려 있습니다 · 이 기간에는 기록{" "}
                  {stat.전체기록}건이 있습니다
                </p>
                <button
                  className="mt-3 rounded border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:border-neutral-500"
                  onClick={() => setFilter(clearFilter)}
                >
                  필터 지우기
                </button>
              </>
            )}
          </div>
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

      {exportMenu.menu && (
        <ContextMenu state={exportMenu.menu} onClose={exportMenu.close} />
      )}
    </div>
  );
}
