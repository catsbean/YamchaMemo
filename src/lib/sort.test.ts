import { describe, expect, it } from "vitest";
import type { NoteSummary } from "../bindings";
import {
  DATE_SORT,
  TITLE_SORT,
  defaultDir,
  normalizeSort,
  sortNotes,
  type SortOption,
} from "./sort";

function note(
  title: string,
  date: string,
  fm: Record<string, unknown> = {},
  charCount = 0,
): NoteSummary {
  return {
    rel_path: `free/${title}.md`,
    note_type: "free",
    title,
    date,
    tags: [],
    char_count: charCount,
    entry_count: 0,
    frontmatter: fm as NoteSummary["frontmatter"],
  };
}

const titles = (list: NoteSummary[]) => list.map((n) => n.title);

describe("첫 방향", () => {
  it("날짜·글자수는 큰 것부터", () => {
    expect(defaultDir("date")).toBe("desc");
    expect(defaultDir("chars")).toBe("desc");
  });

  it("이름은 가나다순부터", () => {
    expect(defaultDir("title")).toBe("asc");
    expect(defaultDir("author")).toBe("asc");
  });
});

describe("정렬", () => {
  const notes = [
    note("나중글", "2026-01-02"),
    note("가장먼저", "2026-03-01"),
    note("다른글", "2026-02-01"),
  ];

  it("날짜 내림차순이 기본 모습", () => {
    expect(titles(sortNotes(notes, { key: "date", dir: "desc" }))).toEqual([
      "가장먼저",
      "다른글",
      "나중글",
    ]);
  });

  it("방향을 뒤집으면 오래된 것부터", () => {
    expect(titles(sortNotes(notes, { key: "date", dir: "asc" }))).toEqual([
      "나중글",
      "다른글",
      "가장먼저",
    ]);
  });

  it("제목은 한국어 가나다순", () => {
    expect(titles(sortNotes(notes, { key: "title", dir: "asc" }))).toEqual([
      "가장먼저",
      "나중글",
      "다른글",
    ]);
  });

  it("원본 배열을 건드리지 않는다", () => {
    const before = titles(notes);
    sortNotes(notes, { key: "title", dir: "asc" });
    expect(titles(notes)).toEqual(before);
  });
});

describe("frontmatter 칸으로 세우기", () => {
  const books = [
    note("나", "2026-01-01", { author: "한강" }),
    note("가", "2026-01-02", { author: "김영하" }),
    note("다", "2026-01-03", {}),
  ];

  it("작가 가나다순", () => {
    expect(titles(sortNotes(books, { key: "author", dir: "asc" }))).toEqual([
      "가",
      "나",
      "다",
    ]);
  });

  it("값이 빈 노트는 차례를 뒤집어도 늘 뒤에 남는다", () => {
    const desc = titles(sortNotes(books, { key: "author", dir: "desc" }));
    expect(desc).toEqual(["나", "가", "다"]);
  });
});

describe("숫자 칸", () => {
  const rated = [
    note("아홉", "2026-01-01", { rating: 9 }),
    note("열", "2026-01-02", { rating: 10 }),
    note("둘", "2026-01-03", { rating: 2 }),
  ];

  it("글자로 견주지 않는다 — 10이 9보다 크다", () => {
    const opts: SortOption[] = [{ key: "rating", label: "평점", numeric: true }];
    expect(titles(sortNotes(rated, { key: "rating", dir: "desc" }, opts))).toEqual(
      ["열", "아홉", "둘"],
    );
  });

  it("글자수도 노트에서 바로 꺼내 견준다", () => {
    const long = note("긴글", "2026-01-01", {}, 1200);
    const short = note("짧은글", "2026-01-02", {}, 30);
    const opts: SortOption[] = [{ key: "chars", label: "글자수", numeric: true }];
    expect(
      titles(sortNotes([short, long], { key: "chars", dir: "desc" }, opts)),
    ).toEqual(["긴글", "짧은글"]);
  });
});

describe("정해진 차례가 있는 칸", () => {
  const opts: SortOption[] = [
    { key: "status", label: "상태", order: ["reading", "wishlist", "finished"] },
  ];
  const books = [
    note("완독한책", "2026-01-01", { status: "finished" }),
    note("읽는책", "2026-01-02", { status: "reading" }),
    note("살책", "2026-01-03", { status: "wishlist" }),
  ];

  it("가나다가 아니라 정해 둔 순서를 따른다", () => {
    expect(titles(sortNotes(books, { key: "status", dir: "asc" }, opts))).toEqual(
      ["읽는책", "살책", "완독한책"],
    );
  });

  it("목록에 없는 값은 뒤로", () => {
    const withUnknown = [...books, note("모를책", "2026-01-04", { status: "zzz" })];
    expect(
      titles(sortNotes(withUnknown, { key: "status", dir: "asc" }, opts)).at(-1),
    ).toBe("모를책");
  });
});

describe("같은 값끼리의 차례", () => {
  it("최신이 먼저, 그다음 제목 — 열 때마다 흔들리지 않게", () => {
    const same = [
      note("나", "2026-01-01", { genre: "소설" }),
      note("가", "2026-01-01", { genre: "소설" }),
      note("다", "2026-05-05", { genre: "소설" }),
    ];
    expect(titles(sortNotes(same, { key: "genre", dir: "asc" }))).toEqual([
      "다",
      "가",
      "나",
    ]);
  });
});

describe("저장해 둔 정렬 다듬기", () => {
  const opts = [DATE_SORT, TITLE_SORT];

  it("성한 값은 그대로", () => {
    expect(normalizeSort({ key: "title", dir: "asc" }, opts)).toEqual({
      key: "title",
      dir: "asc",
    });
  });

  it("없어진 칸을 가리키면 기본 정렬로", () => {
    expect(normalizeSort({ key: "사라진칸", dir: "asc" }, opts)).toEqual({
      key: "date",
      dir: "desc",
    });
  });

  it("저장된 게 없어도 기본 정렬", () => {
    expect(normalizeSort(undefined, opts)).toEqual({ key: "date", dir: "desc" });
  });

  it("방향만 망가졌으면 그 칸의 첫 방향으로", () => {
    expect(normalizeSort({ key: "title", dir: "옆으로" }, opts)).toEqual({
      key: "title",
      dir: "asc",
    });
  });
});
