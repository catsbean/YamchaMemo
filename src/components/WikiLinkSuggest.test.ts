import { describe, expect, it } from "vitest";
import type { LinkOption } from "../lib/resolveLink";
import { contextKey, matches as rank, refreshAction, suggestKey } from "./WikiLinkSuggest";

describe("조합 중에 눌린 키 알아보기", () => {
  // 실제 앱(WebView2)에서 본 것 — `[[이`를 조합 중에 ↓를 누르면 key는 Process로 온다
  it("조합 중 화살표는 물리 키로 알아본다", () => {
    expect(suggestKey({ key: "Process", code: "ArrowDown", keyCode: 229 })).toBe("ArrowDown");
    expect(suggestKey({ key: "Process", code: "ArrowUp", keyCode: 229 })).toBe("ArrowUp");
  });

  it("조합 중 Enter·Tab은 풀어 주지 않는다 (IME가 글자를 확정하게 둔다)", () => {
    expect(suggestKey({ key: "Process", code: "Enter", keyCode: 229 })).toBe("Process");
    expect(suggestKey({ key: "Process", code: "Tab", keyCode: 229 })).toBe("Process");
  });

  it("평소 키는 그대로", () => {
    expect(suggestKey({ key: "ArrowDown", code: "ArrowDown", keyCode: 40 })).toBe("ArrowDown");
    expect(suggestKey({ key: "Enter", code: "Enter", keyCode: 13 })).toBe("Enter");
    expect(suggestKey({ key: "a", code: "KeyA", keyCode: 65 })).toBe("a");
  });
});

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

  // 예전에는 여덟 개에서 잘라, 아홉째부터는 글자를 더 쳐야만 닿았다 (목록은 스크롤된다)
  it("아홉째 후보도 목록에 있다 — 서른 개까지", () => {
    const many = Array.from({ length: 40 }, (_, i) => `노트 ${i}`);
    expect(matches(many, "노트")).toHaveLength(30);
  });
});

describe("초성으로 찾기", () => {
  it("초성만 쳐도 찾는다", () => {
    expect(matches(TITLES, "ㅇㅅ")).toEqual([
      "역사 개론",
      "역사적 예수",
      "한국의 역사적 인물",
    ]);
  });

  it("띄어쓰기는 무시한다", () => {
    expect(matches(TITLES, "ㅇㅅㄱㄹ")).toEqual(["역사 개론"]);
    expect(matches(TITLES, "ㅋㄹ ㅇㅋ")).toEqual(["클린 아키텍처"]);
  });

  it("초성 한 글자로도 건다 (`역`을 치는 첫 순간이 `ㅇ`이다)", () => {
    expect(matches(TITLES, "ㅋ")).toEqual(["클린 아키텍처"]);
  });

  it("완성된 글자가 섞이면 초성으로 보지 않는다", () => {
    expect(matches(TITLES, "역ㅅ")).toEqual([]);
  });

  it("영문 이름은 초성에 걸리지 않는다", () => {
    // `Clean Code`의 C를 ㅊ·ㅋ으로 읽어 주지 않는다 (ㅋ은 `클린 아키텍처`만 건다)
    expect(matches(TITLES, "ㅋㄷ")).toEqual([]);
  });
});

describe("후보가 많을 때의 속도", () => {
  // 편집기는 글자마다 이 함수를 부른다. 1만 편(이름 1만 5천 개)에서 한 프레임을 넘기면 안 된다
  it("1만 5천 개에서도 눈에 띄게 멈추지 않는다 (실측 3~36ms — 넉넉히 200ms로 지킨다)", () => {
    const many = opts(
      Array.from({ length: 15000 }, (_, i) => `노트 ${i} 역사적 기록 ${i % 97}`),
    );
    const time = (q: string) => {
      const t = performance.now();
      rank(many, q);
      return performance.now() - t;
    };
    const took = { empty: time(""), one: time("역"), initials: time("ㅇㅅ"), miss: time("없는말") };
    console.log("matchLinkOptions 15000개:", took);
    for (const ms of Object.values(took)) expect(ms).toBeLessThan(200);
  });
});

describe("목록을 새로 잡을지 그대로 둘지", () => {
  // `[[역사`까지 친 상태 — 커서는 네 글자 뒤
  const at = { query: "역사", caret: 4 };

  it("처음 열릴 때는 새로 잡는다", () => {
    expect(refreshAction(null, at)).toBe("reset");
  });

  // 고쳐진 자리 — ↓로 내려간 뒤 손을 떼면(keyup) 맨 위로 되돌아갔다
  it("화살표를 눌렀다 떼도 고른 자리를 되돌리지 않는다", () => {
    const shown = contextKey(at);
    // keyup은 글자도 커서도 안 바꾼 채 refresh를 부른다
    expect(refreshAction(shown, at)).toBe("keep");
    expect(refreshAction(shown, { ...at })).toBe("keep");
  });

  it("글자를 더 치면 새로 잡는다", () => {
    expect(refreshAction(contextKey(at), { query: "역사적", caret: 5 })).toBe("reset");
  });

  it("글자를 지워도 새로 잡는다", () => {
    expect(refreshAction(contextKey(at), { query: "역", caret: 3 })).toBe("reset");
  });

  it("같은 글자라도 다른 자리의 `[[`면 새로 잡는다", () => {
    expect(refreshAction(contextKey(at), { query: "역사", caret: 20 })).toBe("reset");
  });

  it("링크 밖으로 나가면 닫는다", () => {
    expect(refreshAction(contextKey(at), null)).toBe("close");
    expect(refreshAction(null, null)).toBe("close");
  });
});
