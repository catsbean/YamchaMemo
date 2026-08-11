import { describe, expect, it } from "vitest";
import type { NoteSummary } from "../bindings";
import { pastFieldValues } from "./FrontmatterForm";

function note(note_type: string, frontmatter: Record<string, unknown>): NoteSummary {
  return {
    rel_path: `${note_type}/${Math.random()}.md`,
    note_type,
    title: "",
    date: "2026-08-11",
    tags: [],
    char_count: 0,
    entry_count: 0,
    frontmatter,
  } as unknown as NoteSummary;
}

describe("지난 입력값 모으기", () => {
  it("같은 분류에서만 모으고, 자주 쓴 값이 앞에 온다", () => {
    const notes = [
      note("writing", { category: "에세이" }),
      note("writing", { category: "소설" }),
      note("writing", { category: "소설" }),
      note("book", { category: "딴 분류" }),
    ];
    expect(pastFieldValues(notes, "writing").category).toEqual(["소설", "에세이"]);
  });

  it("공백을 다듬고 빈 값·문자열이 아닌 값은 버린다", () => {
    const notes = [
      note("writing", { category: "  에세이  ", episode: 3, series: "" }),
      note("writing", { category: "에세이" }),
    ];
    const out = pastFieldValues(notes, "writing");
    expect(out.category).toEqual(["에세이"]);
    expect(out.episode).toBeUndefined();
    expect(out.series).toBeUndefined();
  });

  it("본문처럼 긴 값은 고를 거리가 아니라 버린다", () => {
    const notes = [note("free", { memo: "가".repeat(61), short: "가".repeat(60) })];
    const out = pastFieldValues(notes, "free");
    expect(out.memo).toBeUndefined();
    expect(out.short).toHaveLength(1);
  });

  it("맞는 노트가 없으면 빈 객체", () => {
    expect(pastFieldValues([], "free")).toEqual({});
  });
});
