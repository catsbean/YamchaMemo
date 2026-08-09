// 회고에서 "무엇을 보여 줄지"를 정하는 판정. 화면에서 떼어 두는 이유는 두 가지다 —
// 조건이 아홉 가지라 눈으로 훑어서는 맞는지 알 수 없고, 화면에 보이는 것과
// 인쇄물이 **같은 함수**를 봐야 하기 때문이다.

import type { NoteTodo, ReadingEntry, ReviewDay } from "../bindings";
import { addDays, daysBetween, WEEK, weekdayIndex, ymd } from "./date";
import { inlineTags } from "./tags";

export type CardSource = "daily" | "book";
export type TimeSlot = "morning" | "afternoon" | "evening";
export type Span = "week" | "month" | "custom";

/** 필터가 보는 최소 단위 — 일지 콜아웃 하나 또는 독서기록 하나. */
export interface ReviewCard {
  /** 이 카드가 속한 날 (`YYYY-MM-DD`) */
  date: string;
  source: CardSource;
  kindLabel: string;
  text: string;
  /** 콜아웃 헤더에 적힌 시각 (`HH:MM`). **일지 기록만 갖는다** —
   *  독서기록의 헤더 자리에는 날짜가 들어간다 (콜아웃을 만드는 함수가 서로 다르다) */
  time: string;
  /** 본문 인라인 `#태그` + 소속 노트(일지·책)에 달린 태그 */
  tags: string[];
  /** 카드를 눌렀을 때 열 곳 — 일지면 그 날 일지, 독서기록이면 그 책 */
  rel: string;
  /** 독서기록일 때만 채워진다 (카드 배지·책별 좁히기) */
  bookTitle: string;
}

/** 회고에서 지금 걸려 있는 조건. 모든 항목은 **AND**로 겹쳐 적용된다.
 *
 *  기간(from~to)은 여기 없다 — 그건 무엇을 불러올지의 문제라 화면이 따로 들고 있고,
 *  이 타입은 **불러온 것 중 무엇을 남길지**만 말한다. */
export interface ReviewFilter {
  /** 요일 (0=일 … 6=토). 비면 전부 */
  weekdays: number[];
  /** 콜아웃 종류 이름. 비면 전부 — **고르기** 방식이다 */
  kinds: string[];
  /** 고른 태그를 **전부** 가진 카드만 */
  tags: string[];
  /** 이 말이 전부 든 카드만 (AND) */
  include: string;
  /** 이 말이 하나라도 들면 뺀다 (OR) */
  exclude: string;
  source: "all" | CardSource;
  /** 책 한 권으로 좁히기. rel과 제목을 함께 든다 —
   *  칩과 인쇄물이 제목을 적으려면 매번 책 목록을 뒤져야 해서 */
  bookRel: string;
  bookTitle: string;
  /** 시간대. 비면 전부 */
  slots: TimeSlot[];
  todo: "all" | "done" | "open" | "hide";
  order: "new" | "old";
}

export const DEFAULT_FILTER: ReviewFilter = {
  weekdays: [],
  kinds: [],
  tags: [],
  include: "",
  exclude: "",
  source: "all",
  bookRel: "",
  bookTitle: "",
  slots: [],
  todo: "all",
  order: "new",
};

// ── 카드 만들기 ───────────────────────────────────────────────────

/** `15:17` 꼴인가. 독서기록 헤더(`2026-07-18`)와 갈라내는 유일한 수단이다 */
const isTime = (s: string) => /^\d{1,2}:\d{2}$/.test(s);

const mergeTags = (noteTags: string[], text: string) => [
  ...new Set([...noteTags, ...inlineTags(text)]),
];

/** 하루치 일지 → 카드들. 콜아웃이 아닌 원문 블록은 카드가 아니다 (종류가 없다) */
export function cardsOfDay(day: ReviewDay): ReviewCard[] {
  return day.blocks
    .filter((b) => b.kind === "callout")
    .map((b) => ({
      date: day.date,
      source: "daily" as const,
      kindLabel: b.kind_label,
      text: b.text,
      time: isTime(b.date) ? b.date : "",
      tags: mergeTags(day.tags, b.text),
      rel: day.rel_path,
      bookTitle: "",
    }));
}

export function cardOfReading(e: ReadingEntry): ReviewCard {
  return {
    date: e.date,
    source: "book",
    kindLabel: e.kind_label,
    text: e.text,
    time: "", // 독서기록에는 시각이 없다
    tags: mergeTags(e.tags, e.text),
    rel: e.book_rel,
    bookTitle: e.book_title,
  };
}

/** 시각 → 시간대.
 *
 *  저녁이 자정을 넘어 04:59까지 이어진다. 자정 넘겨 남긴 `00:36` 같은 기록을
 *  "오전"에 넣으면 그날 아침 일과로 보이지만, 실은 전날 밤의 연장이다. */
export function slotOf(time: string): TimeSlot | null {
  if (!isTime(time)) return null;
  const h = Number(time.split(":")[0]);
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 18) return "afternoon";
  return "evening";
}

// ── 판정 ─────────────────────────────────────────────────────────

/** 검색창의 제외어와 같은 규칙으로 나눈다 (띄어쓰기·쉼표) */
const words = (s: string) =>
  s
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

/** 카드 하나가 조건을 통과하는가 (전부 AND) */
export function cardPasses(c: ReviewCard, f: ReviewFilter): boolean {
  if (f.source !== "all" && c.source !== f.source) return false;
  // 책 한 권으로 좁히면 일지 기록은 볼 자리가 아니다
  if (f.bookRel && (c.source !== "book" || c.rel !== f.bookRel)) return false;
  if (f.kinds.length > 0 && !f.kinds.includes(c.kindLabel)) return false;
  if (f.weekdays.length > 0 && !f.weekdays.includes(weekdayIndex(c.date)))
    return false;
  if (f.slots.length > 0) {
    // 시각이 없는 카드(독서기록 전부)는 여기서 빠진다 — 통과시키면
    // "오전만"을 골랐는데 독서기록이 통째로 남아 더 이상하다
    const s = slotOf(c.time);
    if (!s || !f.slots.includes(s)) return false;
  }
  if (f.tags.length > 0) {
    const has = new Set(c.tags);
    if (!f.tags.every((t) => has.has(t))) return false;
  }
  return textPasses(c.text, f);
}

/** 포함·제외어 판정. 대상은 **본문뿐**이다 — 책 제목이나 종류 이름까지 보면
 *  왜 이 카드가 걸렸는지 설명할 수 없다 (그건 출처·종류 필터의 일이다) */
function textPasses(text: string, f: ReviewFilter): boolean {
  const body = text.toLowerCase();
  const inc = words(f.include);
  if (inc.length > 0 && !inc.every((w) => body.includes(w))) return false;
  const exc = words(f.exclude);
  if (exc.length > 0 && exc.some((w) => body.includes(w))) return false;
  return true;
}

export function filterCards(cards: ReviewCard[], f: ReviewFilter): ReviewCard[] {
  return cards.filter((c) => cardPasses(c, f));
}

/** 할 일에는 **요일·말·상태만** 건다.
 *  종류·태그·시간대는 콜아웃의 속성이라 체크박스 줄에는 뜻이 없다. */
export function filterTodos(
  todos: NoteTodo[],
  date: string,
  f: ReviewFilter,
): NoteTodo[] {
  if (f.todo === "hide") return [];
  // 독서기록으로 좁힌 화면에 일지의 할 일이 남아 있으면 앞뒤가 안 맞는다
  if (f.source === "book" || f.bookRel) return [];
  if (f.weekdays.length > 0 && !f.weekdays.includes(weekdayIndex(date)))
    return [];
  return todos.filter((t) => {
    if (f.todo === "done" && !t.done) return false;
    if (f.todo === "open" && t.done) return false;
    return textPasses(t.text, f);
  });
}

export interface DateGroup {
  date: string;
  cards: ReviewCard[];
}

/** 날짜 섹션으로 되묶는다.
 *
 *  `order`는 **날짜 사이**의 순서만 뒤집는다. 하루 안에서는 늘 쓴 순서 그대로다 —
 *  그게 그날의 흐름이고, 뒤집으면 앞뒤 문맥이 이어지는 기록이 거꾸로 읽힌다. */
export function groupByDate(cards: ReviewCard[], f: ReviewFilter): DateGroup[] {
  const m = new Map<string, ReviewCard[]>();
  for (const c of cards) m.set(c.date, [...(m.get(c.date) ?? []), c]);
  return [...m.keys()]
    .sort((a, b) => (f.order === "old" ? a.localeCompare(b) : b.localeCompare(a)))
    .map((date) => ({ date, cards: m.get(date)! }));
}

/** 카드를 좁히는 조건이 하나라도 걸려 있는가.
 *
 *  이걸 보는 곳이 하나 있다 — **카드가 0인 날짜 섹션을 숨길지**. 필터가 없으면
 *  할 일만 있는 날도 그대로 보여야 한다(예전부터 그랬다). 필터가 걸렸을 때만
 *  "조건에 맞는 게 없는 날"로 보고 접는다. */
export function hasCardFilter(f: ReviewFilter): boolean {
  return (
    f.weekdays.length > 0 ||
    f.kinds.length > 0 ||
    f.tags.length > 0 ||
    f.include.trim() !== "" ||
    f.exclude.trim() !== "" ||
    f.source !== "all" ||
    f.bookRel !== "" ||
    f.slots.length > 0
  );
}

// ── 적용 중인 필터 보여 주기 ──────────────────────────────────────

export type FilterKey =
  | "weekdays"
  | "kinds"
  | "tags"
  | "include"
  | "exclude"
  | "source"
  | "book"
  | "slots"
  | "todo";

export const SLOT_LABEL: Record<TimeSlot, string> = {
  morning: "오전",
  afternoon: "오후",
  evening: "저녁",
};

const quoted = (s: string) => `"${words(s).join(" ")}"`;

/** 걸린 조건을 사람이 읽는 문장으로.
 *  화면의 칩 줄과 인쇄물의 머리 줄이 **이 함수 하나**를 본다 — 따로 쓰면 언젠가 갈라진다. */
export function activeChips(f: ReviewFilter): { key: FilterKey; label: string }[] {
  const out: { key: FilterKey; label: string }[] = [];
  if (f.weekdays.length > 0)
    out.push({
      key: "weekdays",
      label: `요일 ${[...f.weekdays].sort().map((d) => WEEK[d]).join("·")}`,
    });
  if (f.kinds.length > 0)
    out.push({ key: "kinds", label: `종류 ${f.kinds.join("·")}` });
  if (f.tags.length > 0)
    out.push({
      key: "tags",
      // 여럿이면 "모두 가진 것"임을 적는다 — 아무 것이나 하나로 오해하기 쉽다
      label: `태그 ${f.tags.map((t) => `#${t}`).join(" ")}${f.tags.length > 1 ? " (모두)" : ""}`,
    });
  if (f.include.trim())
    out.push({
      key: "include",
      label: `${quoted(f.include)} ${words(f.include).length > 1 ? "모두 " : ""}포함`,
    });
  if (f.exclude.trim())
    out.push({ key: "exclude", label: `${quoted(f.exclude)} 제외` });
  if (f.source !== "all")
    out.push({
      key: "source",
      label: f.source === "daily" ? "일지 기록만" : "독서기록만",
    });
  if (f.bookRel)
    out.push({ key: "book", label: `책 ${f.bookTitle || f.bookRel}` });
  if (f.slots.length > 0)
    out.push({
      key: "slots",
      label: f.slots.map((s) => SLOT_LABEL[s]).join("·"),
    });
  if (f.todo !== "all")
    out.push({
      key: "todo",
      label:
        f.todo === "done"
          ? "끝낸 할 일만"
          : f.todo === "open"
            ? "남은 할 일만"
            : "할 일 숨김",
    });
  return out;
}

/** 칩 배지에 적을 수 — 칩 개수와 같아야 헷갈리지 않는다 */
export const filterCount = (f: ReviewFilter) => activeChips(f).length;

/** 칩의 × — 그 항목만 기본값으로 되돌린다 */
export function clearChip(f: ReviewFilter, key: FilterKey): ReviewFilter {
  switch (key) {
    case "weekdays":
      return { ...f, weekdays: [] };
    case "kinds":
      return { ...f, kinds: [] };
    case "tags":
      return { ...f, tags: [] };
    case "include":
      return { ...f, include: "" };
    case "exclude":
      return { ...f, exclude: "" };
    case "source":
      return { ...f, source: "all" };
    case "book":
      return { ...f, bookRel: "", bookTitle: "" };
    case "slots":
      return { ...f, slots: [] };
    case "todo":
      return { ...f, todo: "all" };
  }
}

/** 필터는 지우고 정렬은 남긴다 — 정렬은 좁히는 조건이 아니라 보는 방식이다 */
export const clearFilter = (f: ReviewFilter): ReviewFilter => ({
  ...DEFAULT_FILTER,
  order: f.order,
});

// ── 설정에서 읽어 온 값 다듬기 ────────────────────────────────────

const str = (v: unknown) => (typeof v === "string" ? v : "");
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;
const strList = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** 저장해 둔 값 → 쓸 수 있는 필터.
 *  모르는 필드는 버리고 빠진 필드는 기본값으로 채운다 — 다음 판에서 모양이
 *  바뀌어도 예전 설정 때문에 앱이 깨지지 않도록. */
export function normalizeFilter(raw: unknown): ReviewFilter {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_FILTER };
  const r = raw as Record<string, unknown>;
  return {
    weekdays: Array.isArray(r.weekdays)
      ? [...new Set(r.weekdays.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))]
      : [],
    kinds: strList(r.kinds),
    tags: strList(r.tags),
    include: str(r.include),
    exclude: str(r.exclude),
    source: oneOf(r.source, ["all", "daily", "book"] as const, "all"),
    bookRel: str(r.bookRel),
    bookTitle: str(r.bookTitle),
    slots: [
      ...new Set(
        strList(r.slots).filter((s): s is TimeSlot =>
          ["morning", "afternoon", "evening"].includes(s),
        ),
      ),
    ],
    todo: oneOf(r.todo, ["all", "done", "open", "hide"] as const, "all"),
    order: oneOf(r.order, ["new", "old"] as const, "new"),
  };
}

// ── 기간 ─────────────────────────────────────────────────────────

export interface Range {
  from: string;
  to: string;
  label: string;
}

/** 지금 보고 있는 기간.
 *  주·달은 기준 날짜에서 계산하고, 직접 지정은 사용자가 넣은 양끝을 그대로 쓴다. */
export function rangeOf(
  span: Span,
  anchor: string,
  custom: { from: string; to: string },
): Range {
  if (span === "custom") {
    const n = daysBetween(custom.from, custom.to);
    return {
      from: custom.from,
      to: custom.to,
      label: `${custom.from} ~ ${custom.to}${n > 0 ? ` (${n}일)` : ""}`,
    };
  }
  const d = new Date(`${anchor}T00:00:00`);
  if (span === "month") {
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return {
      from: ymd(first),
      to: ymd(last),
      label: `${first.getFullYear()}년 ${first.getMonth() + 1}월`,
    };
  }
  // 월요일 시작
  const wd = (d.getDay() + 6) % 7;
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - wd);
  const sun = new Date(d.getFullYear(), d.getMonth(), d.getDate() - wd + 6);
  return { from: ymd(mon), to: ymd(sun), label: `${ymd(mon)} ~ ${ymd(sun)}` };
}

/** 앞뒤로 한 칸.
 *  직접 지정한 기간은 **폭을 그대로 두고 통째로** 민다 — "지난 열흘"과
 *  "그 앞 열흘"을 견주는 것이 기간을 직접 정하는 이유다. */
export function stepRange(
  span: Span,
  anchor: string,
  custom: { from: string; to: string },
  by: number,
): { anchor: string; custom: { from: string; to: string } } {
  if (span === "custom") {
    const n = Math.max(1, daysBetween(custom.from, custom.to));
    return {
      anchor,
      custom: {
        from: addDays(custom.from, n * by),
        to: addDays(custom.to, n * by),
      },
    };
  }
  const d = new Date(`${anchor}T00:00:00`);
  const next =
    span === "month"
      ? new Date(d.getFullYear(), d.getMonth() + by, 1)
      : new Date(d.getFullYear(), d.getMonth(), d.getDate() + by * 7);
  return { anchor: ymd(next), custom };
}

/** 파일 이름에 쓸 짧은 기간 표기 — 괄호 안 일수는 파일명에 어울리지 않는다 */
export const rangeFileLabel = (r: Range) =>
  r.label.replace(/\s*\(\d+일\)$/, "").replace(/\s*~\s*/, "~");
