import { useEffect, useMemo, useState } from "react";
import type { CalloutKind } from "../lib/callouts";
import { styleOf } from "../lib/callouts";
import { addDays, WEEK, ymd } from "../lib/date";
import {
  activeChips,
  clearChip,
  clearFilter,
  SLOT_LABEL,
  type ReviewCard,
  type ReviewFilter,
  type Span,
  type TimeSlot,
} from "../lib/reviewFilter";
import Segmented from "./Segmented";

/** 월요일부터 늘어놓는다 — 주간 회고가 월요일에 시작하니 눈이 그 순서에 익다 */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const SLOTS: TimeSlot[] = ["morning", "afternoon", "evening"];

/** 자주 쓰는 기간. **전체 기간은 일부러 없다** — 몇 년치 기록이 한꺼번에
 *  건너오면 느려지고, 전체를 훑는 건 검색이 할 일이다. */
const PRESETS: [string, number][] = [
  ["최근 7일", 7],
  ["최근 30일", 30],
  ["최근 90일", 90],
];

interface Props {
  open: boolean;
  filter: ReviewFilter;
  setFilter: React.Dispatch<React.SetStateAction<ReviewFilter>>;
  span: Span;
  setSpan: (s: Span) => void;
  custom: { from: string; to: string };
  setCustom: (c: { from: string; to: string }) => void;
  /** 기간 안의 모든 카드 — 종류·태그·책 목록의 모수다 (vault 전체가 아니라) */
  cards: ReviewCard[];
  kindOf: (label: string) => CalloutKind;
  /** 저장해 둔 마지막 필터. 없으면 불러오기 단추를 감춘다 */
  saved: ReviewFilter | null;
  onLoadSaved: () => void;
}

/** 회고를 좁히는 조건들 — 접히는 패널 + 늘 보이는 "적용 중" 칩 줄.
 *
 *  팝오버가 아니라 접히는 블록인 이유는, 회고가 모달 안에서도 열리기 때문이다.
 *  모달 안에서 뜨는 팝오버는 가장자리에서 잘린다. */
export default function ReviewFilterPanel({
  open,
  filter,
  setFilter,
  span,
  setSpan,
  custom,
  setCustom,
  cards,
  kindOf,
  saved,
  onLoadSaved,
}: Props) {
  const chips = activeChips(filter);

  // 종류·태그·책 목록은 지금 보고 있는 기간에서 뽑는다.
  // vault 전체에서 뽑으면 고를 수는 있어도 결과가 0건인 조건이 잔뜩 늘어선다.
  const kinds = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cards) m.set(c.kindLabel, (m.get(c.kindLabel) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [cards]);

  const tags = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cards) for (const t of c.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"))
      .map(([t]) => t);
  }, [cards]);

  const books = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cards) if (c.source === "book") m.set(c.rel, c.bookTitle);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], "ko"));
  }, [cards]);

  const [allTagsOpen, setAllTagsOpen] = useState(false);
  const shownTags = allTagsOpen
    ? tags
    : [...new Set([...filter.tags, ...tags.slice(0, 8)])];

  // 포함·제외는 치는 대로 걸리면 글자마다 수백 장을 다시 거른다. 입력칸은 바로
  // 반응하되 필터에는 조금 늦게 넘긴다.
  const [inc, setInc] = useState(filter.include);
  const [exc, setExc] = useState(filter.exclude);
  useEffect(() => setInc(filter.include), [filter.include]);
  useEffect(() => setExc(filter.exclude), [filter.exclude]);
  useEffect(() => {
    const t = setTimeout(
      () => setFilter((f) => (f.include === inc ? f : { ...f, include: inc })),
      200,
    );
    return () => clearTimeout(t);
  }, [inc, setFilter]);
  useEffect(() => {
    const t = setTimeout(
      () => setFilter((f) => (f.exclude === exc ? f : { ...f, exclude: exc })),
      200,
    );
    return () => clearTimeout(t);
  }, [exc, setFilter]);

  const toggleIn = <T,>(list: T[], v: T): T[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const preset = (days: number) => {
    const today = ymd(new Date());
    setCustom({ from: addDays(today, -(days - 1)), to: today });
    setSpan("custom");
  };

  return (
    <>
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-neutral-100 bg-neutral-50 px-6 py-2 text-xs">
          <span className="text-2xs text-neutral-400">적용 중</span>
          {chips.map((c) => (
            <span
              key={c.key}
              className="flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-neutral-700 ring-1 ring-neutral-300"
            >
              {c.label}
              <button
                className="text-neutral-400 hover:text-neutral-800"
                onClick={() => setFilter((f) => clearChip(f, c.key))}
                title="이 조건만 빼기"
              >
                ×
              </button>
            </span>
          ))}
          <button
            className="ml-auto text-neutral-500 underline hover:text-neutral-800"
            onClick={() => setFilter(clearFilter)}
          >
            초기화
          </button>
        </div>
      )}

      {!open ? null : (
        <div className="border-b border-neutral-200 bg-neutral-50 text-xs">
          <Row label="기간">
            <Segmented
              value={span}
              options={
                [
                  ["week", "주간"],
                  ["month", "월간"],
                  ["custom", "기간 지정"],
                ] as const
              }
              onChange={setSpan}
            />
            {span === "custom" && (
              <>
                <input
                  type="date"
                  className="rounded border border-neutral-300 px-1.5 py-0.5 focus:border-neutral-500 focus:outline-none"
                  value={custom.from}
                  onChange={(e) => setCustom({ ...custom, from: e.target.value })}
                />
                <span className="text-neutral-400">~</span>
                <input
                  type="date"
                  className="rounded border border-neutral-300 px-1.5 py-0.5 focus:border-neutral-500 focus:outline-none"
                  value={custom.to}
                  onChange={(e) => setCustom({ ...custom, to: e.target.value })}
                />
              </>
            )}
            {PRESETS.map(([label, d]) => (
              <Chip key={label} on={false} onClick={() => preset(d)}>
                {label}
              </Chip>
            ))}
            <Chip
              on={false}
              onClick={() => {
                const y = new Date().getFullYear();
                setCustom({ from: `${y}-01-01`, to: ymd(new Date()) });
                setSpan("custom");
              }}
            >
              올해
            </Chip>
          </Row>

          <Row label="요일">
            {WEEKDAY_ORDER.map((d) => (
              <Chip
                key={d}
                on={filter.weekdays.includes(d)}
                onClick={() =>
                  setFilter((f) => ({ ...f, weekdays: toggleIn(f.weekdays, d) }))
                }
              >
                {WEEK[d]}
              </Chip>
            ))}
          </Row>

          {kinds.length > 0 && (
            <Row label="종류" hint="아무것도 안 고르면 전부 봅니다">
              {kinds.map(([label, n]) => {
                const k = kindOf(label);
                const on = filter.kinds.includes(label);
                return (
                  <button
                    key={label}
                    className={`rounded-full border border-current/10 px-2 py-0.5 ${
                      on ? styleOf(k.color).active : styleOf(k.color).idle
                    }`}
                    onClick={() =>
                      setFilter((f) => ({ ...f, kinds: toggleIn(f.kinds, label) }))
                    }
                    title="이 종류만 보기"
                  >
                    {k.icon} {label} {n}
                  </button>
                );
              })}
            </Row>
          )}

          {tags.length > 0 && (
            <Row
              label="태그"
              hint={filter.tags.length > 1 ? "고른 태그를 모두 가진 것만" : undefined}
            >
              {shownTags.map((t) => (
                <button
                  key={t}
                  className={`rounded-full px-2.5 py-0.5 ${
                    filter.tags.includes(t)
                      ? "bg-violet-600 text-white"
                      : "bg-violet-50 text-violet-600 hover:bg-violet-100"
                  }`}
                  onClick={() => setFilter((f) => ({ ...f, tags: toggleIn(f.tags, t) }))}
                >
                  #{t}
                </button>
              ))}
              {tags.length > shownTags.length && (
                <button
                  className="text-neutral-500 underline hover:text-neutral-800"
                  onClick={() => setAllTagsOpen(true)}
                >
                  +{tags.length - shownTags.length}개 더
                </button>
              )}
            </Row>
          )}

          <Row label="말">
            <span className="text-neutral-400">포함</span>
            <input
              className="min-w-0 flex-1 rounded border border-neutral-300 px-1.5 py-0.5 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none"
              placeholder="적은 말이 모두 든 기록만 (띄어쓰기로 여러 개)"
              value={inc}
              onChange={(e) => setInc(e.target.value)}
            />
            <span className="text-neutral-400">제외</span>
            <input
              className="min-w-0 flex-1 rounded border border-neutral-300 px-1.5 py-0.5 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none"
              placeholder="하나라도 들면 뺍니다"
              value={exc}
              onChange={(e) => setExc(e.target.value)}
            />
          </Row>

          <Row label="출처">
            <Segmented
              value={filter.source}
              options={
                [
                  ["all", "둘 다"],
                  ["daily", "일지 기록"],
                  ["book", "독서기록"],
                ] as const
              }
              onChange={(v) => setFilter((f) => ({ ...f, source: v }))}
            />
            {books.length > 0 && filter.source !== "daily" && (
              <select
                className="rounded border border-neutral-300 px-1.5 py-0.5 focus:border-neutral-500 focus:outline-none"
                value={filter.bookRel}
                onChange={(e) => {
                  const rel = e.target.value;
                  setFilter((f) => ({
                    ...f,
                    bookRel: rel,
                    // 제목을 함께 든다 — 칩과 인쇄물이 매번 책 목록을 뒤지지 않도록
                    bookTitle: books.find(([r]) => r === rel)?.[1] ?? "",
                  }));
                }}
              >
                <option value="">책 전부</option>
                {books.map(([rel, title]) => (
                  <option key={rel} value={rel}>
                    {title}
                  </option>
                ))}
              </select>
            )}
          </Row>

          <Row label="시간대" hint="시각이 적힌 일지 기록만 남습니다">
            {SLOTS.map((s) => (
              <Chip
                key={s}
                on={filter.slots.includes(s)}
                onClick={() => setFilter((f) => ({ ...f, slots: toggleIn(f.slots, s) }))}
              >
                {SLOT_LABEL[s]}
              </Chip>
            ))}
          </Row>

          <Row label="할 일">
            <Segmented
              value={filter.todo}
              options={
                [
                  ["all", "전부"],
                  ["done", "끝낸 것만"],
                  ["open", "남은 것만"],
                  ["hide", "숨기기"],
                ] as const
              }
              onChange={(v) => setFilter((f) => ({ ...f, todo: v }))}
            />
            <span className="ml-4 text-neutral-400">정렬</span>
            <Segmented
              value={filter.order}
              options={
                [
                  ["new", "최신순"],
                  ["old", "오래된순"],
                ] as const
              }
              onChange={(v) => setFilter((f) => ({ ...f, order: v }))}
            />
            {saved && (
              <button
                className="ml-auto rounded border border-neutral-300 bg-white px-2 py-0.5 text-neutral-600 hover:border-neutral-500"
                onClick={onLoadSaved}
                title="지난번에 쓰던 조건을 그대로 다시 겁니다 (기간은 그대로 둡니다)"
              >
                ↺ 마지막 필터
              </button>
            )}
          </Row>
        </div>
      )}
    </>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-neutral-100 px-6 py-1.5 last:border-b-0">
      <span className="w-12 shrink-0 text-2xs text-neutral-400">{label}</span>
      {children}
      {hint && <span className="ml-1 text-2xs text-neutral-400">{hint}</span>}
    </div>
  );
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={`rounded-full px-2.5 py-0.5 ${
        on
          ? "bg-neutral-800 text-white"
          : "bg-white text-neutral-600 ring-1 ring-neutral-300 hover:bg-neutral-100"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
