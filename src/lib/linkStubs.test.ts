import { describe, expect, it } from "vitest";
import type { NoteSummary } from "../bindings";
import { isCreatable, linkTargetsIn, missingTargets } from "./linkStubs";

function note(rel: string, title: string, aliases: string[] = []): NoteSummary {
  return {
    rel_path: rel,
    note_type: "free",
    title,
    date: "2026-11-12",
    tags: [],
    char_count: 0,
    entry_count: 0,
    frontmatter: { title, aliases },
  };
}

describe("본문에서 링크 타깃 뽑기", () => {
  it("타깃만 남기고 겹치는 것은 한 번만", () => {
    expect(linkTargetsIn("[[회의]] 그리고 [[회의|어제 회의]] [[장보기#채소]]")).toEqual([
      "회의",
      "장보기",
    ]);
  });

  it("닫히지 않은 링크는 링크가 아니다", () => {
    expect(linkTargetsIn("쓰는 중 [[회의")).toEqual([]);
    expect(linkTargetsIn("[[]] [[ ]]")).toEqual([]);
  });

  it("코드 안의 [[ ]]는 글자다", () => {
    expect(linkTargetsIn("문법은 `[[이름]]` 이다")).toEqual([]);
    expect(linkTargetsIn("```\n[[코드 속]]\n```\n[[밖]]")).toEqual(["밖"]);
    expect(linkTargetsIn("~~~js\n[[코드 속]]\n~~~\n[[밖]]")).toEqual(["밖"]);
  });

  it("닫히지 않은 코드 블록은 끝까지 코드로 본다", () => {
    expect(linkTargetsIn("[[앞]]\n```\n[[쓰는 중인 코드]]")).toEqual(["앞"]);
  });

  it("줄을 넘는 것은 링크가 아니다", () => {
    expect(linkTargetsIn("[[첫 줄\n둘째 줄]]")).toEqual([]);
  });
});

describe("만들 수 있는 이름", () => {
  it("폴더까지 적은 링크·날짜·빈 이름은 만들지 않는다", () => {
    expect(isCreatable("Books/없는 책")).toBe(false);
    expect(isCreatable("2026-11-12")).toBe(false);
    expect(isCreatable("  ")).toBe(false);
    expect(isCreatable("회의: 3월")).toBe(true);
  });
});

describe("만들어야 할 이름 고르기", () => {
  const notes = [note("Free/카레.md", "카레"), note("Writing/초고.md", "초고", ["비비풀"])];

  it("이미 있는 글(제목·별칭)은 뺀다", () => {
    expect(missingTargets("[[카레]] [[비비풀]] [[새 글]]", notes, null)).toEqual(["새 글"]);
  });

  // 고치는 중인 링크 — `[[회의]]`에 커서를 두고 `록`을 치는 동안 자동저장이 돈다
  it("커서가 든 링크는 뺀다", () => {
    expect(missingTargets("[[회의]] [[새 글]]", notes, "회의")).toEqual(["새 글"]);
  });

  it("만들지 않는 이름은 뺀다", () => {
    expect(missingTargets("[[2026-11-12]] [[Free/어디]]", notes, null)).toEqual([]);
  });
});
