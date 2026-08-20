import { describe, expect, it } from "vitest";
import { canMoveType, fmDisplay, josaRo, listFields } from "./note";

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

describe("목록 뱃지 값 만들기", () => {
  const note = (frontmatter: Record<string, unknown>) => ({ frontmatter });

  it("문자열과 숫자를 그대로 쓴다", () => {
    expect(fmDisplay(note({ 분류: "화학" }), "분류")).toBe("화학");
    expect(fmDisplay(note({ 회차: 3 }), "회차")).toBe("3");
  });

  it("목록은 이어 붙이고 빈 값은 버린다", () => {
    expect(fmDisplay(note({ aliases: ["비비풀", "", "BB"] }), "aliases")).toBe(
      "비비풀, BB",
    );
  });

  /** 위키링크 칸은 `[[화학]]`으로 저장된다 — 뱃지에 대괄호까지 나오면 지저분하다 */
  it("위키링크는 대괄호를 걷어낸다", () => {
    expect(fmDisplay(note({ 상위: "[[화학]]" }), "상위")).toBe("화학");
  });

  it("없는 칸이나 모르는 모양은 빈 문자열", () => {
    expect(fmDisplay(note({}), "분류")).toBe("");
    expect(fmDisplay(note({ 분류: { a: 1 } }), "분류")).toBe("");
    expect(fmDisplay(null, "분류")).toBe("");
  });
});

describe("목록에 내보일 칸 고르기", () => {
  const f = (name: string, in_list: boolean) => ({ name, label: name, in_list });

  it("켠 칸만 준다", () => {
    const schema = { fields: [f("분류", true), f("출처", false)] };
    expect(listFields(schema).map((x) => x.name)).toEqual(["분류"]);
  });

  /** 줄이 이미 보여 주는 값이라 켜져 있어도 두 번 내보내지 않는다 */
  it("날짜·태그는 켜져 있어도 뺀다", () => {
    const schema = { fields: [f("date", true), f("tags", true), f("분류", true)] };
    expect(listFields(schema).map((x) => x.name)).toEqual(["분류"]);
  });

  /** 예전 `_types.json`에서 온 칸에는 이 값이 아예 없다 — 없으면 끔이다 */
  it("in_list가 없는 칸은 끈 것으로 본다", () => {
    expect(listFields({ fields: [{ name: "분류", label: "분류" }] })).toEqual([]);
  });

  it("분류 정의가 없으면 빈 목록", () => {
    expect(listFields(null)).toEqual([]);
    expect(listFields(undefined)).toEqual([]);
  });
});
