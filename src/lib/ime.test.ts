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

  it("조합 중에도 기본 동작(줄바꿈 삽입)을 막는다", async () => {
    // 안 막으면 브라우저가 이 Enter로 줄바꿈을 넣어 버려서, 조합이 끝나며
    // 확정 글자가 들어오는 시점과 뒤섞여 값이 망가질 수 있다.
    const { field } = mount("value-then-end");
    field.typeWord(GEULJA); // 마지막 음절 "자"가 조합 중인 채로
    field.keydown(CTRL_ENTER);
    expect(field.defaultPrevented).toBe(true);
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

/** 실제 앱(WebView2 디버깅 포트)에서 잡은 이벤트 순서를 그대로 옮긴 것.
 *
 *  이 IME는 `compositionstart/end`를 아예 내지 않는다 — 음절을 곧바로 확정해 넣고,
 *  고쳐 쓸 때는 지웠다 다시 넣는다. Ctrl이 눌려 있으면 그 백스페이스가 브라우저에서
 *  **단어 통째 지우기**가 되어 앞 글자까지 날아간다:
 *
 *      input insertText "록"        value="기록"
 *      keydown Control              value="기록"
 *      input deleteWordBackward     value=""      ← 단어가 통째로 사라진다
 *      input insertText "록"        value="록"
 *      keydown Ctrl+Enter           value="록"    ← 여기서 발사됐다
 *
 *  조합 상태만 보던 상태 기계에는 이 경로가 보이지 않았다. */
describe("조합을 안 쓰는 IME — Ctrl에 단어를 삼킬 때", () => {
  it('"기록"을 치고 Ctrl+Enter하면 "기록"이 간다', async () => {
    const { field, sent } = mount("value-then-end");
    field.commitSyllable("기");
    field.commitSyllable("록");
    expect(field.value).toBe("기록");

    field.holdCtrl();
    field.imeRevisionUnderCtrl("록");
    expect(field.value).toBe("록"); // 입력창은 이 꼴이 된다

    field.keydown(CTRL_ENTER);
    await settle();
    expect(sent).toEqual(["기록"]);
  });

  it("앞말이 있어도 그 단어만 되돌린다", async () => {
    const { field, sent } = mount("value-then-end");
    for (const ch of "오늘 ") field.typeAscii(ch);
    field.commitSyllable("기");
    field.commitSyllable("록");

    field.holdCtrl();
    field.imeRevisionUnderCtrl("록");
    field.keydown(CTRL_ENTER);
    await settle();
    expect(sent).toEqual(["오늘 기록"]);
  });

  it("보내지 않고 Ctrl에서 손을 떼도 입력창이 성하다", async () => {
    const { field } = mount("value-then-end");
    field.commitSyllable("기");
    field.commitSyllable("록");

    field.holdCtrl();
    field.imeRevisionUnderCtrl("록");
    field.releaseCtrl();

    expect(field.value).toBe("기록");
  });

  /** 사람이 일부러 누른 Ctrl+Backspace까지 되돌리면 안 된다.
   *  둘은 "지운 자리에 곧바로 글자가 다시 들어오는가"로 갈린다. */
  it("사람이 지운 단어는 되살리지 않는다", async () => {
    const { field, sent } = mount("value-then-end");
    for (const ch of "hello world") field.typeAscii(ch);

    field.holdCtrl();
    field.deleteWordBackward(); // 다시 넣지 않는다 — 사람이 지운 것
    expect(field.value).toBe("hello ");

    field.keydown(CTRL_ENTER);
    await settle();
    expect(sent).toEqual(["hello "]);
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
  it("조합 중과 값이 있을 때만 감춘다", async () => {
    const { field, core } = mount("value-then-end");
    const hidden = () => field.classes.has("ime-composing");

    expect(hidden()).toBe(false); // 입력 전
    field.compose("ㄱ");
    expect(hidden()).toBe(true); // 조합 중
    field.compose("글");
    field.finishComposition()?.();
    expect(hidden()).toBe(true); // 값이 남아 있으면 계속
    core.clear();
    await settle();
    expect(hidden()).toBe(false); // 비우면 다시 보인다
  });

  /** 한글 IME는 음절을 고칠 때마다 글자를 지웠다 다시 넣는다. 첫 음절을 쓰는 동안에는
   *  그 사이 값이 통째로 빈 칸이 된다 — 곧바로 안내 문구를 되살리면 글자마다 번쩍인다.
   *  실측: `기록` 한 단어를 치는 동안 3번 되살아났다. */
  it("글자를 지웠다 다시 넣는 사이에는 안내 문구가 돌아오지 않는다", async () => {
    const { field } = mount("value-then-end");
    const shown = () => !field.classes.has("ime-composing");

    field.commitSyllable("ㄱ");
    expect(shown()).toBe(false);

    // IME가 고쳐 쓰려고 지운다 → 값이 잠깐 빈 칸
    field.deleteBack();
    expect(field.value).toBe("");
    expect(shown()).toBe(false); // 여기서 되살아나면 깜빡인다

    field.commitSyllable("기"); // 곧바로 다시 넣는다
    await settle();
    expect(shown()).toBe(false);
    expect(field.value).toBe("기");
  });

  it("진짜로 다 지우면 안내 문구가 돌아온다", async () => {
    const { field } = mount("value-then-end");
    field.commitSyllable("기");
    field.deleteBack();

    expect(field.classes.has("ime-composing")).toBe(true); // 아직은 참는다
    await settle();
    expect(field.classes.has("ime-composing")).toBe(false); // 그대로 비어 있으면 돌아온다
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
