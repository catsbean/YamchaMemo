import { describe, expect, it } from "vitest";
import type { NoteTodo } from "../bindings";
import { buildReviewDoc, type ReviewSection } from "./exportReview";
import { DEFAULT_FILTER, type ReviewCard, type ReviewFilter } from "./reviewFilter";

const daily = (over: Partial<ReviewCard> = {}): ReviewCard => ({
  date: "2026-08-06",
  source: "daily",
  kindLabel: "기록",
  text: "회의함",
  time: "15:17",
  tags: [],
  rel: "Daily/2026/08/2026-08-06.md",
  bookTitle: "",
  ...over,
});

const book = (over: Partial<ReviewCard> = {}): ReviewCard => ({
  date: "2026-08-06",
  source: "book",
  kindLabel: "발췌",
  text: "읽기 쉬운 코드",
  time: "",
  tags: [],
  rel: "Books/clean.md",
  bookTitle: "클린 코드",
  ...over,
});

const todo = (over: Partial<NoteTodo> = {}): NoteTodo =>
  ({ index: 0, done: false, text: "우유 사기", ...over }) as NoteTodo;

const section = (over: Partial<ReviewSection> = {}): ReviewSection => ({
  date: "2026-08-06",
  cards: [daily()],
  todos: [],
  ...over,
});

const info = (filter: ReviewFilter = DEFAULT_FILTER) => ({
  label: "2026년 8월",
  filter,
});

describe("회고 내보내기", () => {
  it("독서기록도 함께 담는다", () => {
    // 예전에는 화면에는 보이는데 인쇄하면 빠졌다 — 이 테스트가 그 갭을 지킨다
    const d = buildReviewDoc([section({ cards: [daily(), book()] })], info());
    expect(d.html).toContain("회의함");
    expect(d.html).toContain("읽기 쉬운 코드");
    expect(d.text).toContain("읽기 쉬운 코드");
  });

  it("독서기록 카드의 머리에 날짜와 책 제목이 붙는다", () => {
    const d = buildReviewDoc([section({ cards: [book()] })], info());
    expect(d.html).toContain("클린 코드");
    expect(d.html).toContain("2026-08-06");
  });

  it("일지 기록의 머리에는 시각이 붙는다", () => {
    const d = buildReviewDoc([section({ cards: [daily()] })], info());
    expect(d.html).toContain("15:17");
  });

  it("사용자가 만든 종류의 아이콘·색이 문서까지 내려간다", () => {
    // 사용자 정의 종류만 골라 인쇄하면 예전에는 통째로 회색 + 💬가 됐다
    const d = buildReviewDoc(
      [section({ cards: [daily({ kindLabel: "메모" })] })],
      info(),
      [{ label: "메모", icon: "📝", color: "rose" }],
    );
    expect(d.html).toContain("📝 메모");
    expect(d.html).not.toContain("💬");
  });

  it("날짜 머리에 요일이 붙는다", () => {
    const d = buildReviewDoc([section({})], info());
    // 2026-08-06은 목요일
    expect(d.html).toContain("2026-08-06 (목)");
  });

  it("할 일은 체크 상태 그대로 나간다", () => {
    const d = buildReviewDoc(
      [section({ todos: [todo({ done: true }), todo({ index: 1, done: false })] })],
      info(),
    );
    expect(d.text).toContain("- [x] 우유 사기");
    expect(d.text).toContain("- [ ] 우유 사기");
  });

  it("머리 줄에 기간·건수를 적는다", () => {
    const d = buildReviewDoc(
      [section({ cards: [daily(), book()], todos: [todo({ done: true })] })],
      info(),
    );
    expect(d.meta).toContain("2026년 8월");
    expect(d.meta).toContain("기록 2건");
    expect(d.meta).toContain("끝낸 할 일 1건");
  });

  it("필터가 없으면 필터 절을 아예 빼고, 있으면 화면 칩과 같은 말로 적는다", () => {
    expect(buildReviewDoc([section({})], info()).meta).not.toContain("필터:");

    const filtered = buildReviewDoc(
      [section({})],
      info({ ...DEFAULT_FILTER, kinds: ["기록"], include: "예산", todo: "open" }),
    );
    expect(filtered.meta).toContain("필터: 종류 기록");
    expect(filtered.meta).toContain('"예산" 포함');
    expect(filtered.meta).toContain("남은 할 일만");
  });

  it("여러 날은 준 순서를 지킨다 — 화면의 정렬이 그대로 문서가 된다", () => {
    const d = buildReviewDoc(
      [
        section({ date: "2026-08-03", cards: [daily({ date: "2026-08-03", text: "먼저" })] }),
        section({ date: "2026-08-06", cards: [daily({ text: "나중" })] }),
      ],
      info(),
    );
    expect(d.html.indexOf("먼저")).toBeLessThan(d.html.indexOf("나중"));
  });

  it("여러 줄 기록이 콜아웃 안에서 이어진다", () => {
    const d = buildReviewDoc(
      [section({ cards: [daily({ text: "첫 줄\n둘째 줄" })] })],
      info(),
    );
    expect(d.html).toContain("첫 줄");
    expect(d.html).toContain("둘째 줄");
  });

  it("제목은 기간을 달고 나온다", () => {
    expect(buildReviewDoc([section({})], info()).title).toBe("회고 2026년 8월");
  });
});
