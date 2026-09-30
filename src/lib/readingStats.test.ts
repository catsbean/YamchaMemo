import { describe, expect, it } from "vitest";
import type { NoteSummary } from "../bindings";
import { GENRE_NONE, finishedDateOf, finishedIn, readingStats } from "./readingStats";

function book(title: string, fm: Record<string, unknown>, date = "2026-01-01"): NoteSummary {
  return {
    rel_path: `Books/${title}.md`,
    note_type: "book",
    title,
    date,
    tags: [],
    char_count: 0,
    entry_count: 0,
    frontmatter: fm as NoteSummary["frontmatter"],
  };
}

const done = (title: string, finished: string, extra: Record<string, unknown> = {}, date?: string) =>
  book(title, { status: "finished", finished, ...extra }, date);

describe("완독 날짜", () => {
  it("완독이 아니면 날짜가 없다", () => {
    expect(finishedDateOf(book("a", { status: "reading", finished: "2026-03-01" }))).toBe("");
  });

  it("완독일이 비면 노트 날짜로 센다 — 홈이 원래 세던 규칙", () => {
    expect(finishedDateOf(done("a", "", {}, "2025-11-02"))).toBe("2025-11-02");
    expect(finishedDateOf(done("a", "2024-05-06", {}, "2025-11-02"))).toBe("2024-05-06");
  });

  it("해로 고른다", () => {
    const books = [done("a", "2026-02-01"), done("b", "2025-12-31"), book("c", { status: "reading" })];
    expect(finishedIn(books, "2026").map((b) => b.title)).toEqual(["a"]);
  });
});

describe("통계", () => {
  const books = [
    done("가", "2024-03-10", { genre: "소설", rating: 5 }),
    done("나", "2026-01-15", { genre: "소설", rating: 4.4 }),
    done("다", "2026-01-20", { genre: "역사", rating: "3" }),
    done("라", "2026-07-01", { genre: "" }), // 분야·평점 없음
    done("마", "", { genre: "역사" }, "2026-07-09"), // 완독일 없음 → 노트 날짜
    done("바", "2026", { genre: "과학", rating: 0 }), // 해만 적힘, 평점 0 = 없음
    book("사", { status: "reading", genre: "소설", rating: 5 }), // 완독 아님 — 어디에도 안 센다
    book("아", { status: "wishlist" }),
  ];

  it("해별 막대는 빈 해도 0으로 채운다", () => {
    expect(readingStats(books, null).byYear).toEqual([
      { year: "2024", count: 1 },
      { year: "2025", count: 0 },
      { year: "2026", count: 5 },
    ]);
  });

  it("전체 기간 — 숫자가 서로 맞는다", () => {
    const s = readingStats(books, null);
    expect(s.finished).toBe(6);
    expect(s.genres.reduce((n, g) => n + g.count, 0)).toBe(s.finished);
    expect(s.ratings.reduce((n, r) => n + r.count, 0) + s.unrated).toBe(s.finished);
    expect(s.byMonth).toEqual([]);
    expect(s.undated).toBe(1);
  });

  it("해를 고르면 월별이 생기고, 해만 적힌 책은 달 막대에서 빠진다", () => {
    const s = readingStats(books, "2026");
    expect(s.finished).toBe(5);
    expect(s.byMonth).toHaveLength(12);
    expect(s.byMonth[0]).toEqual({ month: 1, count: 2 });
    expect(s.byMonth[6]).toEqual({ month: 7, count: 2 });
    expect(s.byMonth.reduce((n, m) => n + m.count, 0)).toBe(4);
  });

  it("분야는 많은 것부터, 분야 없음은 맨 뒤", () => {
    expect(readingStats(books, "2026").genres).toEqual([
      { genre: "역사", count: 2 },
      { genre: "과학", count: 1 },
      { genre: "소설", count: 1 },
      { genre: GENRE_NONE, count: 1 },
    ]);
  });

  it("평점은 반올림해 1~5점에 넣고, 없거나 0이면 따로 센다", () => {
    const s = readingStats(books, "2026");
    expect(s.ratings.map((r) => r.count)).toEqual([0, 0, 1, 1, 0]);
    expect(s.unrated).toBe(3);
    expect(s.average).toBeCloseTo((4.4 + 3) / 2);
  });

  it("완독한 책이 없으면 빈 통계", () => {
    const s = readingStats([book("아", { status: "wishlist" })], null);
    expect(s).toMatchObject({ finished: 0, byYear: [], genres: [], unrated: 0, average: null });
  });
});
