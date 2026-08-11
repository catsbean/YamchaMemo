import { describe, expect, it } from "vitest";
import type { LinkOption } from "../lib/resolveLink";
import { matches as rank } from "./WikiLinkSuggest";

const TITLES = [
  "역사적 예수",
  "한국의 역사적 인물",
  "역사 개론",
  "Clean Code",
  "클린 아키텍처",
];

/** 이 테스트는 순위 규칙만 본다 — 후보를 이름만 있는 꼴로 눌러서 다룬다 */
function opts(names: string[]): LinkOption[] {
  return names.map((label) => ({ label, insert: label, detail: "" }));
}
function matches(names: string[], query: string): string[] {
  return rank(opts(names), query).map((o) => o.label);
}

describe("위키링크 추천 고르기", () => {
  // 처음 보고된 자리 — `[[역사적`을 쳤는데 `역사적 예수`가 안 떴다
  it("한글 앞글자로 찾는다", () => {
    expect(matches(TITLES, "역사적")).toEqual([
      "역사적 예수",
      "한국의 역사적 인물",
    ]);
  });

  it("앞부터 맞는 것이 위로 온다", () => {
    // 둘 다 `역사적`을 품지만, 제목이 그걸로 시작하는 쪽이 먼저다
    expect(matches(TITLES, "역사적")[0]).toBe("역사적 예수");
  });

  it("조합 중인 글자로도 찾는다 (`역사`까지 친 상태)", () => {
    expect(matches(TITLES, "역사")).toContain("역사 개론");
    expect(matches(TITLES, "역사")).toContain("역사적 예수");
  });

  it("영문은 대소문자를 가리지 않는다", () => {
    expect(matches(TITLES, "clean")).toEqual(["Clean Code"]);
  });

  it("앞뒤 공백은 무시한다", () => {
    expect(matches(TITLES, "  역사적 ")).toEqual(matches(TITLES, "역사적"));
  });

  it("아직 아무것도 안 쳤으면 전부 보여 준다", () => {
    expect(matches(TITLES, "")).toHaveLength(TITLES.length);
  });

  it("맞는 게 없으면 빈 목록", () => {
    expect(matches(TITLES, "없는제목")).toEqual([]);
  });

  it("여덟 개를 넘기지 않는다", () => {
    const many = Array.from({ length: 20 }, (_, i) => `노트 ${i}`);
    expect(matches(many, "노트")).toHaveLength(8);
  });
});
