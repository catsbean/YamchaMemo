import { beforeAll, describe, expect, it } from "vitest";
import { createImeCore, isImeEnter } from "./ime";
import { FakeField, fakeDocument, type ImeOrder } from "./ime.sim";

// 상태 기계가 조합을 확정시킬 때 document.activeElement를 본다
beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = fakeDocument;
});

/** 입력창 하나 + 상태 기계 하나를 붙여서 돌린다 */
function mount(order: ImeOrder, mode: "enter" | "ctrl-enter" = "ctrl-enter") {
  const sent: string[] = [];
  const field = new FakeField(order);
  const ref = { current: null as never };
  const core = createImeCore(ref, () => ({
    onSubmit: (v: string) => sent.push(v),
    mode,
  }));
  field.attach(core.handlers as never);
  return { field, sent, core };
}

/** "글자" — ㄱ,그,글 확정 후 ㅈ,자 조합 중 */
const GEULJA = [
  ["ㄱ", "그", "글"],
  ["ㅈ", "자"],
];

const CTRL_ENTER = { key: "Enter", ctrlKey: true };
/** 조합 중에는 브라우저가 key를 "Process"로 가린다 (물리 키는 code에만 남는다) */
const CTRL_ENTER_MASKED = { key: "Process", code: "Enter", ctrlKey: true };

const settle = () => new Promise((r) => setTimeout(r, 150));

describe("한글 조합 중 Ctrl+Enter", () => {
  it("값이 먼저 들어오는 순서에서 온전히 보낸다", async () => {
    const { field, sent } = mount("value-then-end");
    field.typeWord(GEULJA);
    field.keydown(CTRL_ENTER);
    await settle();
    expect(sent).toEqual(["글자"]);
  });

  it('Enter가 "Process"로 가려져도 알아본다', async () => {
    const { field, sent } = mount("value-then-end");
    field.typeWord(GEULJA);
    field.keydown(CTRL_ENTER_MASKED);
    await settle();
    expect(sent).toEqual(["글자"]);
  });

  it("확정이 value보다 먼저 와도 마지막 글자를 잃지 않는다", async () => {
    const { field, sent } = mount("end-then-value");
    field.typeWord(GEULJA);
    const late = field.finishComposition(); // Ctrl에서 IME가 먼저 확정
    field.keydown(CTRL_ENTER);
    late?.(); // 확정 글자가 이제야 value에 들어온다
    await settle();
    expect(sent).toEqual(["글자"]);
  });

  it("포커스를 빼도 조합이 안 끝나면 늦게라도 온전히 보낸다", async () => {
    const { field, sent } = mount("blur-ignores");
    field.typeWord(GEULJA);
    field.keydown(CTRL_ENTER);
    field.finishComposition()?.();
    await settle();
    expect(sent).toEqual(["글자"]);
  });

  it("IME 자체 확정과 겹쳐도 같은 음절이 두 번 들어가지 않는다", async () => {
    const { field, sent } = mount("value-then-end");
    field.typeWord(GEULJA);
    field.keydown(CTRL_ENTER_MASKED); // 가려진 키가 먼저 온다
    field.imeCommitsOnEnter(); // 그 뒤 IME가 자기 조합을 확정한다
    await settle();
    expect(sent).toEqual(["글자"]);
    expect(field.value).toBe("글자"); // "글자자"가 되면 안 된다
  });
});

describe("조합이 아닐 때", () => {
  it("영문은 그 자리에서 보내고 줄바꿈을 막는다", async () => {
    const { field, sent } = mount("value-then-end");
    for (const c of "hello") field.typeAscii(c);
    field.keydown(CTRL_ENTER);
    await settle();
    expect(sent).toEqual(["hello"]);
    expect(field.defaultPrevented).toBe(true);
  });

  it("Enter 모드에서 Shift+Enter는 보내지 않는다", async () => {
    const { field, sent } = mount("value-then-end", "enter");
    field.typeWord([["ㅎ", "하", "할"]]);
    field.keydown({ key: "Enter", shiftKey: true });
    await settle();
    expect(sent).toEqual([]);
    field.keydown({ key: "Enter" });
    await settle();
    expect(sent).toEqual(["할"]);
  });
});

describe("보낸 뒤 상태", () => {
  it("연달아 두 번 보낼 수 있다", async () => {
    const { field, sent, core } = mount("value-then-end");
    field.typeWord(GEULJA);
    field.keydown(CTRL_ENTER);
    await settle();
    core.clear();
    field.typeWord([
      ["ㄷ", "두"],
      ["ㄹ", "루"],
    ]);
    field.keydown(CTRL_ENTER);
    await settle();
    expect(sent).toEqual(["글자", "두루"]);
  });

  it("clear() 뒤에 조합 찌꺼기가 남지 않는다", () => {
    const { field, core } = mount("value-then-end");
    field.typeWord([["ㅈ", "자"]]);
    core.clear();
    expect(field.value).toBe("");
    expect(field.composing).toBe(false);
  });
});

describe("placeholder 깜빡임 방지", () => {
  it("조합 중과 값이 있을 때만 감춘다", () => {
    const { field, core } = mount("value-then-end");
    const hidden = () => field.classes.has("ime-composing");

    expect(hidden()).toBe(false); // 입력 전
    field.compose("ㄱ");
    expect(hidden()).toBe(true); // 조합 중
    field.compose("글");
    field.finishComposition()?.();
    expect(hidden()).toBe(true); // 값이 남아 있으면 계속
    core.clear();
    expect(hidden()).toBe(false); // 비우면 다시 보인다
  });
});

describe("isImeEnter — 값을 state로 들고 있는 입력창용 가드", () => {
  it("조합 중 Enter를 걸러 낸다", () => {
    expect(isImeEnter({ key: "Enter", nativeEvent: { isComposing: true } })).toBe(true);
    expect(isImeEnter({ key: "Process", nativeEvent: {} })).toBe(true);
    expect(isImeEnter({ key: "Enter", nativeEvent: { keyCode: 229 } })).toBe(true);
  });

  it("조합이 끝난 Enter는 통과시킨다", () => {
    expect(isImeEnter({ key: "Enter", nativeEvent: { isComposing: false } })).toBe(false);
    expect(isImeEnter({ key: "Enter", nativeEvent: {} })).toBe(false);
  });
});
