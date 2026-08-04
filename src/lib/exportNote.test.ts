import { describe, expect, it } from "vitest";
import type { ReadingEntry } from "../bindings";
import { buildNoteDoc, buildReadingDoc } from "./exportNote";
import { joinSections } from "./exportHtml";

function entry(over: Partial<ReadingEntry>): ReadingEntry {
  return {
    book_rel: "Books/a.md",
    book_title: "클린 코드",
    book_author: "마틴",
    genre: "개발",
    tags: [],
    cover: "",
    kind_label: "발췌",
    date: "2026-08-01",
    text: "읽기 쉬운 코드",
    ...over,
  } as ReadingEntry;
}

describe("독서기록 내보내기", () => {
  it("책별로 묶고 기록을 그 아래 붙인다", () => {
    const d = buildReadingDoc([
      entry({}),
      entry({ kind_label: "생각", text: "네이밍이 8할" }),
      entry({ book_rel: "Books/b.md", book_title: "소나기", book_author: "황순원" }),
    ]);
    expect(d.html).toContain("<h2>클린 코드</h2>");
    expect(d.html).toContain("<h2>소나기</h2>");
    expect(d.meta).toBe("3개 기록 · 책 2권");
    // 같은 책의 기록 둘이 한 묶음 안에 있다
    expect(d.html.indexOf("네이밍이 8할")).toBeLessThan(d.html.indexOf("소나기"));
  });

  it("텍스트에도 책 제목과 기록이 모두 남는다", () => {
    const d = buildReadingDoc([entry({ text: "첫 줄\n둘째 줄" })]);
    expect(d.text).toContain("## 클린 코드 (마틴 · 개발)");
    expect(d.text).toContain("[발췌 · 2026-08-01] 첫 줄");
    // 여러 줄 기록이 뭉개지지 않는다
    expect(d.text).toContain("둘째 줄");
  });

  it("제목에 꺾쇠가 있어도 HTML로 새지 않는다", () => {
    const d = buildReadingDoc([entry({ book_title: "<b>책" })]);
    expect(d.html).toContain("&lt;b&gt;책");
    expect(d.html).not.toContain("<b>책");
  });
});

describe("책 노트 내보내기", () => {
  const book = {
    rel_path: "Books/2026-08-01 클린 코드.md",
    note_type: "book",
    frontmatter: { title: "클린 코드", author: "마틴", status: "done" },
    body: "소개 문단\n\n## 기록\n\n> [!발췌] 09:00\n> 좋은 코드",
  } as never;

  it("소개와 기록을 나눠 담는다", () => {
    const d = buildNoteDoc(book);
    expect(d.title).toBe("클린 코드");
    expect(d.html).toContain("<h2>소개</h2>");
    expect(d.html).toContain("<h2>기록</h2>");
    expect(d.text).toContain("## 기록");
  });
});

describe("여러 편 묶기", () => {
  it("두 번째부터 새 페이지에서 시작한다", () => {
    const html = joinSections([
      { title: "첫 책", html: "<p>가</p>" },
      { title: "둘째 책", html: "<p>나</p>" },
    ]);
    expect(html).toContain("<h1>첫 책</h1>");
    // 첫 편에는 페이지 나눔이 붙지 않는다 (맨 앞에 빈 장이 생기지 않게)
    expect(html.indexOf("break-before:page")).toBeGreaterThan(
      html.indexOf("첫 책"),
    );
    expect(html.match(/break-before:page/g)).toHaveLength(1);
  });
});
