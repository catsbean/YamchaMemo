import { describe, expect, it } from "vitest";
import { parseBlocks } from "./NoteText";

/** 목록 항목을 "기호 글" 꼴로 눌러서 보기 좋게 */
function flat(text: string) {
  return parseBlocks(text).map((b) =>
    b.kind === "text"
      ? { 문단: b.lines.join("\n") }
      : {
          목록: b.items.map(
            (i) =>
              `${"  ".repeat(i.depth)}${
                i.done === null ? (i.num ? `${i.num}.` : "-") : i.done ? "[x]" : "[ ]"
              } ${i.text}`,
          ),
        },
  );
}

describe("기록 카드 본문 나누기", () => {
  it("목록이 없으면 문단 하나", () => {
    expect(flat("그냥 한 줄")).toEqual([{ 문단: "그냥 한 줄" }]);
  });

  it("글 뒤에 붙은 목록을 갈라낸다", () => {
    expect(flat("장 볼 것\n- 우유\n- 계란")).toEqual([
      { 문단: "장 볼 것" },
      { 목록: ["- 우유", "- 계란"] },
    ]);
  });

  it("체크박스·번호·불릿을 구분한다", () => {
    expect(flat("- [ ] 할 일\n- [x] 끝낸 일\n1. 첫째\n2) 둘째\n* 별표")).toEqual([
      { 목록: ["[ ] 할 일", "[x] 끝낸 일", "1. 첫째", "2. 둘째", "- 별표"] },
    ]);
  });

  it("들여쓴 항목의 깊이를 센다 (2칸 = 한 단계, 최대 3단계)", () => {
    expect(flat("- 하나\n  - 둘\n    - 셋\n        - 넷")).toEqual([
      { 목록: ["- 하나", "  - 둘", "    - 셋", "      - 넷"] },
    ]);
  });

  it("목록 사이에 낀 글은 문단으로 되돌아간다", () => {
    expect(flat("- 하나\n딴 얘기\n- 둘")).toEqual([
      { 목록: ["- 하나"] },
      { 문단: "딴 얘기" },
      { 목록: ["- 둘"] },
    ]);
  });

  it("빈 항목(`- `)도 그대로 항목이다 — 파일에 있는 그대로 보여 준다", () => {
    expect(flat("- \n- 우유")).toEqual([{ 목록: ["- ", "- 우유"] }]);
  });

  it("목록이 아닌 하이픈은 글자로 둔다", () => {
    expect(flat("2026-07-18 회고\n-5도까지 떨어졌다")).toEqual([
      { 문단: "2026-07-18 회고\n-5도까지 떨어졌다" },
    ]);
  });
});
