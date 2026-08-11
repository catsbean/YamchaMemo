import { describe, expect, it } from "vitest";
import { canMoveType, josaRo } from "./note";

describe("로/으로 고르기", () => {
  it("받침이 없으면 로", () => {
    // 트·기·피 — 마지막 글자에 받침이 없다
    expect(josaRo("자유노트")).toBe("로");
    expect(josaRo("글쓰기")).toBe("로");
    expect(josaRo("레시피")).toBe("로");
  });

  it("ㄹ 받침도 로", () => {
    expect(josaRo("서울")).toBe("로");
  });

  it("그 밖의 받침은 으로", () => {
    expect(josaRo("회의록")).toBe("으로");
    expect(josaRo("도서리스트")).toBe("로"); // 트는 받침 없음
    expect(josaRo("일기장")).toBe("으로");
  });

  it("한글이 아니면 판정하지 않고 (으)로", () => {
    expect(josaRo("Memo")).toBe("(으)로");
    expect(josaRo("2026")).toBe("(으)로");
    expect(josaRo("")).toBe("(으)로");
  });
});

describe("옮길 수 있는 분류", () => {
  it("책·일지는 제자리에 있어야 한다", () => {
    expect(canMoveType("book")).toBe(false);
    expect(canMoveType("daily")).toBe(false);
    expect(canMoveType("free")).toBe(true);
    expect(canMoveType("회의록")).toBe(true);
  });
});
