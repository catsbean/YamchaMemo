import { describe, expect, it } from "vitest";
import type { NoteBlock, NoteTodo, ReadingEntry, ReviewDay } from "../bindings";
import {
  activeChips,
  cardOfReading,
  cardPasses,
  cardsOfDay,
  clearChip,
  clearFilter,
  DEFAULT_FILTER,
  filterCards,
  filterCount,
  filterTodos,
  groupByDate,
  hasCardFilter,
  normalizeFilter,
  rangeFileLabel,
  rangeOf,
  slotOf,
  stepRange,
  type ReviewCard,
  type ReviewFilter,
} from "./reviewFilter";

function block(over: Partial<NoteBlock>): NoteBlock {
  return {
    kind: "callout",
    entry_index: 0,
    kind_label: "기록",
    date: "15:17",
    text: "회의함",
    section: "",
    ...over,
  } as NoteBlock;
}

function day(over: Partial<ReviewDay>): ReviewDay {
  return {
    date: "2026-08-03",
    rel_path: "Daily/2026/08/2026-08-03.md",
    tags: [],
    blocks: [block({})],
    todos: [],
    ...over,
  } as ReviewDay;
}

function entry(over: Partial<ReadingEntry>): ReadingEntry {
  return {
    book_rel: "Books/clean.md",
    book_title: "클린 코드",
    book_author: "마틴",
    genre: "개발",
    tags: [],
    cover: "",
    kind_label: "발췌",
    date: "2026-08-03",
    text: "읽기 쉬운 코드",
    ...over,
  } as ReadingEntry;
}

function card(over: Partial<ReviewCard>): ReviewCard {
  return {
    date: "2026-08-03",
    source: "daily",
    kindLabel: "기록",
    text: "회의함",
    time: "15:17",
    tags: [],
    rel: "Daily/2026/08/2026-08-03.md",
    bookTitle: "",
    ...over,
  };
}

const f = (over: Partial<ReviewFilter> = {}): ReviewFilter => ({
  ...DEFAULT_FILTER,
  ...over,
});

function todo(over: Partial<NoteTodo>): NoteTodo {
  return { index: 0, done: false, text: "우유 사기", ...over } as NoteTodo;
}

describe("카드 만들기", () => {
  it("일지 콜아웃의 헤더는 시각으로, 독서기록의 헤더는 날짜로 간다", () => {
    const [c] = cardsOfDay(day({}));
    expect(c.time).toBe("15:17");
    expect(c.date).toBe("2026-08-03");

    const r = cardOfReading(entry({}));
    // 독서기록 헤더 자리에는 날짜가 들어 있다 — 시각으로 오해하면 시간대 필터가 틀린다
    expect(r.time).toBe("");
    expect(r.date).toBe("2026-08-03");
  });

  it("헤더가 빈 콜아웃은 시각이 없다", () => {
    const [c] = cardsOfDay(day({ blocks: [block({ date: "" })] }));
    expect(c.time).toBe("");
  });

  it("콜아웃이 아닌 원문 블록은 카드가 아니다", () => {
    const cards = cardsOfDay(
      day({
        blocks: [block({}), block({ kind: "raw", kind_label: "", text: "맨 글" })],
      }),
    );
    expect(cards).toHaveLength(1);
  });

  it("태그는 본문 인라인과 노트에 달린 것을 함께 본다", () => {
    const [c] = cardsOfDay(
      day({ tags: ["일기"], blocks: [block({ text: "헬스장 #운동 다녀옴" })] }),
    );
    expect(c.tags).toEqual(expect.arrayContaining(["일기", "운동"]));
  });
});

describe("시간대", () => {
  it("오전·오후·저녁으로 가른다", () => {
    expect(slotOf("09:30")).toBe("morning");
    expect(slotOf("13:00")).toBe("afternoon");
    expect(slotOf("21:00")).toBe("evening");
  });

  it("저녁이 자정을 넘어 04:59까지 이어진다", () => {
    // 00:36에 남긴 기록은 그날 아침이 아니라 전날 밤의 연장이다
    expect(slotOf("00:36")).toBe("evening");
    expect(slotOf("04:59")).toBe("evening");
    expect(slotOf("05:00")).toBe("morning");
  });

  it("시각이 없으면 어느 시간대도 아니다", () => {
    expect(slotOf("")).toBeNull();
    expect(slotOf("2026-07-18")).toBeNull();
  });

  it("시간대를 고르면 시각 없는 카드(독서기록)는 빠진다", () => {
    const filter = f({ slots: ["morning"] });
    expect(cardPasses(card({ time: "09:30" }), filter)).toBe(true);
    expect(cardPasses(cardOfReading(entry({})), filter)).toBe(false);
  });
});

describe("말 필터", () => {
  it("포함어는 전부 있어야 하고 제외어는 하나만 있어도 뺀다", () => {
    const c = card({ text: "예산 회의를 했다" });
    expect(cardPasses(c, f({ include: "예산 회의" }))).toBe(true);
    expect(cardPasses(c, f({ include: "예산 점심" }))).toBe(false);
    expect(cardPasses(c, f({ exclude: "점심 회의" }))).toBe(false);
    expect(cardPasses(c, f({ exclude: "점심" }))).toBe(true);
  });

  it("쉼표로도 나눈다", () => {
    expect(cardPasses(card({ text: "예산 회의" }), f({ include: "예산,회의" }))).toBe(
      true,
    );
  });

  it("영문 대소문자는 가리지 않는다", () => {
    expect(cardPasses(card({ text: "Rust로 고쳤다" }), f({ include: "rust" }))).toBe(
      true,
    );
  });

  it("본문만 본다 — 책 제목이 걸려 들지 않는다", () => {
    const c = cardOfReading(entry({ book_title: "예산론", text: "읽기 쉬운 코드" }));
    expect(cardPasses(c, f({ include: "예산" }))).toBe(false);
  });
});

describe("태그 필터", () => {
  it("여러 개를 고르면 전부 가진 카드만 남는다", () => {
    const c = card({ tags: ["회의", "예산"] });
    expect(cardPasses(c, f({ tags: ["회의"] }))).toBe(true);
    expect(cardPasses(c, f({ tags: ["회의", "예산"] }))).toBe(true);
    expect(cardPasses(c, f({ tags: ["회의", "휴가"] }))).toBe(false);
  });
});

describe("요일 필터", () => {
  it("주가 월요일에 시작하는 것과 무관하게 실제 요일로 건다", () => {
    // 2026-08-03은 월요일(1), 2026-08-09는 일요일(0)
    expect(cardPasses(card({ date: "2026-08-03" }), f({ weekdays: [1] }))).toBe(true);
    expect(cardPasses(card({ date: "2026-08-09" }), f({ weekdays: [1] }))).toBe(false);
    expect(cardPasses(card({ date: "2026-08-09" }), f({ weekdays: [0] }))).toBe(true);
  });
});

describe("출처 필터", () => {
  it("책 한 권으로 좁히면 일지 기록은 빠진다", () => {
    const filter = f({ bookRel: "Books/clean.md", bookTitle: "클린 코드" });
    expect(cardPasses(cardOfReading(entry({})), filter)).toBe(true);
    expect(cardPasses(card({}), filter)).toBe(false);
    expect(
      cardPasses(cardOfReading(entry({ book_rel: "Books/other.md" })), filter),
    ).toBe(false);
  });
});

describe("할 일", () => {
  it("상태로 거른다", () => {
    const ts = [todo({ index: 0, done: true }), todo({ index: 1, done: false })];
    expect(filterTodos(ts, "2026-08-03", f({ todo: "done" }))).toHaveLength(1);
    expect(filterTodos(ts, "2026-08-03", f({ todo: "open" }))).toHaveLength(1);
    expect(filterTodos(ts, "2026-08-03", f({ todo: "hide" }))).toHaveLength(0);
    expect(filterTodos(ts, "2026-08-03", f())).toHaveLength(2);
  });

  it("독서기록으로 좁히면 일지의 할 일이 남지 않는다", () => {
    const ts = [todo({})];
    expect(filterTodos(ts, "2026-08-03", f({ source: "book" }))).toHaveLength(0);
    expect(filterTodos(ts, "2026-08-03", f({ bookRel: "Books/clean.md" }))).toHaveLength(
      0,
    );
  });

  it("종류·태그·시간대는 체크박스에 뜻이 없어 걸지 않는다", () => {
    const ts = [todo({})];
    expect(
      filterTodos(ts, "2026-08-03", f({ kinds: ["느낌"], tags: ["회의"], slots: ["morning"] })),
    ).toHaveLength(1);
  });

  it("말 필터는 할 일에도 걸린다", () => {
    const ts = [todo({ text: "우유 사기" }), todo({ index: 1, text: "설거지" })];
    expect(filterTodos(ts, "2026-08-03", f({ include: "우유" }))).toHaveLength(1);
  });
});

describe("빈 날짜 규칙", () => {
  it("좁히는 조건이 하나도 없으면 hasCardFilter는 거짓 — 할 일만 있는 날이 남는다", () => {
    expect(hasCardFilter(f())).toBe(false);
    // 정렬은 좁히는 조건이 아니다
    expect(hasCardFilter(f({ order: "old" }))).toBe(false);
    // 할 일 상태도 카드를 좁히지 않는다
    expect(hasCardFilter(f({ todo: "open" }))).toBe(false);
  });

  it("카드를 좁히는 조건이 하나라도 있으면 참", () => {
    expect(hasCardFilter(f({ kinds: ["기록"] }))).toBe(true);
    expect(hasCardFilter(f({ include: "예산" }))).toBe(true);
    expect(hasCardFilter(f({ source: "daily" }))).toBe(true);
  });
});

describe("묶기와 정렬", () => {
  it("날짜 사이 순서만 뒤집고 하루 안은 쓴 순서 그대로 둔다", () => {
    const cards = [
      card({ date: "2026-08-03", text: "첫째" }),
      card({ date: "2026-08-03", text: "둘째" }),
      card({ date: "2026-08-05", text: "셋째" }),
    ];
    const recent = groupByDate(cards, f());
    expect(recent.map((g) => g.date)).toEqual(["2026-08-05", "2026-08-03"]);
    expect(recent[1].cards.map((c) => c.text)).toEqual(["첫째", "둘째"]);

    const old = groupByDate(cards, f({ order: "old" }));
    expect(old.map((g) => g.date)).toEqual(["2026-08-03", "2026-08-05"]);
    // 하루 안은 뒤집지 않는다 — 그날의 흐름이 거꾸로 읽히면 안 된다
    expect(old[0].cards.map((c) => c.text)).toEqual(["첫째", "둘째"]);
  });

  it("filterCards는 통과한 것만 남긴다", () => {
    const cards = [card({ kindLabel: "기록" }), card({ kindLabel: "느낌" })];
    expect(filterCards(cards, f({ kinds: ["느낌"] }))).toHaveLength(1);
  });
});

describe("적용 중인 필터 보여 주기", () => {
  it("칩 개수와 배지 수가 같다", () => {
    const filter = f({ kinds: ["기록"], tags: ["회의"], include: "예산", todo: "open" });
    expect(filterCount(filter)).toBe(activeChips(filter).length);
    expect(filterCount(filter)).toBe(4);
  });

  it("태그가 여럿이면 모두 가진 것임을 적는다", () => {
    const one = activeChips(f({ tags: ["회의"] }))[0].label;
    const two = activeChips(f({ tags: ["회의", "예산"] }))[0].label;
    expect(one).not.toContain("모두");
    expect(two).toContain("(모두)");
  });

  it("책 칩에는 제목을 적는다", () => {
    const chip = activeChips(f({ bookRel: "Books/clean.md", bookTitle: "클린 코드" }))[0];
    expect(chip.key).toBe("book");
    expect(chip.label).toContain("클린 코드");
  });

  it("정렬은 칩이 아니다 — 좁히는 조건이 아니라 보는 방식이다", () => {
    expect(activeChips(f({ order: "old" }))).toHaveLength(0);
  });

  it("칩 하나를 지워도 나머지는 그대로다", () => {
    const filter = f({ kinds: ["기록"], tags: ["회의"], include: "예산" });
    const next = clearChip(filter, "tags");
    expect(next.tags).toEqual([]);
    expect(next.kinds).toEqual(["기록"]);
    expect(next.include).toBe("예산");
  });

  it("책 칩을 지우면 경로와 제목이 함께 사라진다", () => {
    const next = clearChip(f({ bookRel: "Books/a.md", bookTitle: "가" }), "book");
    expect(next.bookRel).toBe("");
    expect(next.bookTitle).toBe("");
  });

  it("전체 초기화는 정렬을 남긴다", () => {
    const next = clearFilter(f({ kinds: ["기록"], order: "old" }));
    expect(next.kinds).toEqual([]);
    expect(next.order).toBe("old");
  });
});

describe("저장한 필터 되읽기", () => {
  it("빠진 필드는 기본값으로 채운다", () => {
    expect(normalizeFilter({ kinds: ["기록"] })).toEqual({
      ...DEFAULT_FILTER,
      kinds: ["기록"],
    });
  });

  it("모르는 값과 엉뚱한 타입은 버린다", () => {
    const n = normalizeFilter({
      source: "우주",
      todo: 3,
      slots: ["morning", "새벽"],
      weekdays: [1, 9, "월"],
      kinds: ["기록", 7],
      unknownField: "무시",
    });
    expect(n.source).toBe("all");
    expect(n.todo).toBe("all");
    expect(n.slots).toEqual(["morning"]);
    expect(n.weekdays).toEqual([1]);
    expect(n.kinds).toEqual(["기록"]);
    expect(n).not.toHaveProperty("unknownField");
  });

  it("객체가 아니면 기본값", () => {
    expect(normalizeFilter(null)).toEqual(DEFAULT_FILTER);
    expect(normalizeFilter("필터")).toEqual(DEFAULT_FILTER);
  });
});

describe("기간", () => {
  it("주는 월요일에 시작한다", () => {
    // 2026-08-06은 목요일
    const r = rangeOf("week", "2026-08-06", { from: "", to: "" });
    expect(r.from).toBe("2026-08-03");
    expect(r.to).toBe("2026-08-09");
  });

  it("달은 1일부터 말일까지", () => {
    const r = rangeOf("month", "2026-08-06", { from: "", to: "" });
    expect(r.from).toBe("2026-08-01");
    expect(r.to).toBe("2026-08-31");
    expect(r.label).toBe("2026년 8월");
  });

  it("직접 지정한 기간은 일수를 함께 적는다", () => {
    const r = rangeOf("custom", "", { from: "2026-07-20", to: "2026-07-29" });
    expect(r.label).toBe("2026-07-20 ~ 2026-07-29 (10일)");
  });

  it("직접 지정한 기간은 폭을 그대로 두고 통째로 민다", () => {
    const custom = { from: "2026-07-20", to: "2026-07-29" }; // 10일
    const back = stepRange("custom", "", custom, -1);
    expect(back.custom).toEqual({ from: "2026-07-10", to: "2026-07-19" });
    const fwd = stepRange("custom", "", custom, 1);
    expect(fwd.custom).toEqual({ from: "2026-07-30", to: "2026-08-08" });
  });

  it("주·달은 앵커를 옮긴다", () => {
    expect(stepRange("week", "2026-08-06", { from: "", to: "" }, 1).anchor).toBe(
      "2026-08-13",
    );
    expect(stepRange("month", "2026-08-06", { from: "", to: "" }, -1).anchor).toBe(
      "2026-07-01",
    );
  });

  it("파일 이름용 표기에서는 괄호와 사이 공백을 없앤다", () => {
    expect(
      rangeFileLabel(rangeOf("custom", "", { from: "2026-07-20", to: "2026-07-29" })),
    ).toBe("2026-07-20~2026-07-29");
    expect(rangeFileLabel(rangeOf("month", "2026-08-06", { from: "", to: "" }))).toBe(
      "2026년 8월",
    );
  });
});
