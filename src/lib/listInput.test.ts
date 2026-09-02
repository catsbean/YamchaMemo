import { beforeAll, describe, expect, it } from "vitest";
import { createListCore, mergeEntries, splitEntries } from "./listInput";
import { FakeField, fakeDocument, type ImeOrder } from "./ime.sim";

// 조합을 확정시킬 때 document.activeElement를 본다
beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = fakeDocument;
});

/** 입력칸 하나 + 상태 기계 하나를 붙여서 돌린다 (위의 배열은 여기서 들고 있는다) */
function mount(initial: string[] = [], order: ImeOrder = "value-then-end") {
  let items = initial;
  const field = new FakeField(order);
  const ref = { current: null as never };
  // 실제 컴포넌트도 매 렌더 최신 배열을 물려 준다 — 여기서도 그때그때 읽어 간다
  const core = createListCore(ref, () => ({
    items,
    onChange: (next: string[]) => {
      items = next;
    },
  }));
  field.attach(core.handlers as never);
  return { field, core, items: () => items };
}

const settle = () => new Promise((r) => setTimeout(r, 150));

/** "비비풀" — 음절마다 조합했다 확정한다 */
const BIBIPUL = [
  ["ㅂ", "비"],
  ["ㅂ", "비"],
  ["ㅍ", "푸", "풀"],
];

describe("쉼표로 값 나누기", () => {
  it("쉼표를 치면 앞이 값이 되고 입력칸은 비워진다", () => {
    const m = mount();
    for (const ch of "BB,") m.field.typeAscii(ch);
    expect(m.items()).toEqual(["BB"]);
    expect(m.field.value).toBe("");
  });

  it("쉼표 뒤에 두 번째 값을 이어서 칠 수 있다 (원래 못 하던 것)", () => {
    const m = mount();
    for (const ch of "BB,") m.field.typeAscii(ch);
    for (const ch of "CC,") m.field.typeAscii(ch);
    expect(m.items()).toEqual(["BB", "CC"]);
  });

  it("쉼표 뒤 공백을 먹지 않는다", () => {
    // 값으로 굳힐 때만 다듬는다. 치는 중에 다듬으면 스페이스가 눌리자마자 사라진다.
    const m = mount();
    for (const ch of "BB, ") m.field.typeAscii(ch);
    expect(m.field.value).toBe(" ");
  });

  it("여러 줄을 붙여넣으면 줄마다 값이 된다", () => {
    const m = mount();
    m.field.value = "가\n나\n다,";
    m.core.handlers.onInput();
    expect(m.items()).toEqual(["가", "나", "다"]);
  });

  it("이미 있는 값은 조용히 하나로 둔다", () => {
    const m = mount(["가"]);
    for (const ch of "가,") m.field.typeAscii(ch);
    expect(m.items()).toEqual(["가"]);
    expect(m.field.value).toBe("");
  });
});

describe("한글 조합 중 Enter", () => {
  for (const order of ["value-then-end", "end-then-value"] as ImeOrder[]) {
    it(`마지막 음절을 잃지 않는다 — ${order}`, () => {
      const m = mount([], order);
      m.field.typeWord(BIBIPUL);
      // 조합 중에는 브라우저가 key를 "Process"로 가린다
      m.field.keydown({ key: "Process", code: "Enter" });
      m.field.imeCommitsOnEnter(); // IME가 Enter를 받아 스스로 확정한다
      expect(m.items()).toEqual(["비비풀"]);
      expect(m.field.value).toBe("");
    });

    it(`음절이 두 번 들어가지 않는다 — ${order}`, () => {
      const m = mount([], order);
      m.field.typeWord(BIBIPUL);
      m.field.keydown({ key: "Enter" });
      m.field.imeCommitsOnEnter();
      expect(m.items()).toEqual(["비비풀"]);
    });
  }

  it("조합 중 Enter도 기본 동작을 막는다 (감싼 대화상자가 먼저 닫히지 않게)", () => {
    const m = mount();
    m.field.typeWord(BIBIPUL);
    m.field.keydown({ key: "Process", code: "Enter" });
    expect(m.field.defaultPrevented).toBe(true);
  });

  it("IME가 끝내 확정하지 않으면 포커스를 빼서 확정시킨다", async () => {
    const m = mount();
    m.field.typeWord(BIBIPUL);
    m.field.keydown({ key: "Process", code: "Enter" });
    await settle();
    expect(m.items()).toEqual(["비비풀"]);
  });

  it("조합이 없을 때의 Enter는 그 자리에서 확정한다", () => {
    const m = mount();
    for (const ch of "BB") m.field.typeAscii(ch);
    m.field.keydown({ key: "Enter" });
    expect(m.items()).toEqual(["BB"]);
    expect(m.field.value).toBe("");
  });
});

describe("지우기와 확정", () => {
  it("빈 입력칸에서 Backspace는 마지막 값을 되돌려 놓는다 (지우지 않고)", () => {
    const m = mount(["가", "나"]);
    m.field.keydown({ key: "Backspace" });
    expect(m.items()).toEqual(["가"]);
    expect(m.field.value).toBe("나");
  });

  it("치던 글자가 남아 있으면 Backspace가 값을 건드리지 않는다", () => {
    const m = mount(["가"]);
    m.field.typeAscii("x");
    m.field.keydown({ key: "Backspace" });
    expect(m.items()).toEqual(["가"]);
  });

  it("포커스가 빠지면 적다 만 것도 값이 된다", () => {
    // 마지막 값을 적고 쉼표 없이 [저장]을 눌러도 잃지 않아야 한다
    const m = mount();
    for (const ch of "BB") m.field.typeAscii(ch);
    m.core.handlers.onBlur();
    expect(m.items()).toEqual(["BB"]);
    expect(m.field.value).toBe("");
  });
});

describe("문자열 나누기", () => {
  it("앞뒤 공백을 다듬고 빈 조각은 버린다", () => {
    expect(splitEntries(" 가 , ,나,\n 다 ")).toEqual(["가", "나", "다"]);
    expect(splitEntries("   ")).toEqual([]);
  });

  it("이어 붙일 때 이미 있는 값과 새 값 안의 중복을 함께 거른다", () => {
    expect(mergeEntries(["가"], ["나", "가", "나"])).toEqual(["가", "나"]);
  });
});
