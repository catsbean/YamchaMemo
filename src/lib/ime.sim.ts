/** 한글 IME + 크로미엄 입력창 시뮬레이터 (테스트 전용).
 *
 *  실제 IME는 "조합이 확정되는 시점"과 "확정된 글자가 value에 들어오는 시점"이
 *  브라우저·OS·IME마다 다르게 어긋난다. 그 어긋남이 곧 버그의 원인이었으므로,
 *  순서를 골라 가며 같은 상태 기계를 돌려 어떤 순서에서도 글자를 잃지 않는지 본다.
 *
 *  실제 앱(WebView2)에서 확인한 사실을 그대로 반영했다:
 *  - 조합 중 눌린 키는 `VK_PROCESSKEY`로 가려져 `key: "Process"`로 온다
 *  - 포커스가 빠지면 브라우저가 조합을 그 자리에서 확정한다
 *  - 그런데 IME 엔진은 자기 조합을 따로 들고 있어서, 겹치면 글자가 두 번 들어간다 */

export type ImeOrder =
  /** 값이 먼저 들어오고 compositionend가 뒤 (흔한 순서) */
  | "value-then-end"
  /** compositionend가 먼저, 확정 글자는 그 다음 input에 (문제의 순서) */
  | "end-then-value"
  /** 포커스를 빼도 조합이 안 끝나는 최악의 경우 */
  | "blur-ignores";

interface Handlers {
  ref: { current: unknown };
  onCompositionStart: () => void;
  onCompositionEnd: (e: { data: string }) => void;
  onInput: () => void;
  onKeyDown: (e: Record<string, unknown>) => void;
}

/** `document.activeElement`를 대신한다 (테스트에는 진짜 DOM이 없다) */
export const fakeDocument: { activeElement: unknown } = { activeElement: null };

export class FakeField {
  value = "";
  placeholder = "안내 문구";
  classes = new Set<string>();
  classList = {
    toggle: (c: string, on: boolean) =>
      on ? this.classes.add(c) : this.classes.delete(c),
  };
  defaultPrevented = false;

  /** 브라우저 쪽에서 조합 중인 글자 */
  private composingText = "";
  /** IME 엔진이 아직 들고 있는 조합 글자 (브라우저 쪽 확정과 별개) */
  private imeOwned = "";
  private h!: Handlers;

  constructor(private order: ImeOrder = "value-then-end") {
    fakeDocument.activeElement = this;
  }

  attach(handlers: Handlers) {
    this.h = handlers;
    handlers.ref.current = this;
  }

  get composing() {
    return this.composingText !== "";
  }

  /** IME 조합 갱신 — 조합 중인 음절을 지웠다 다시 넣는 실제 동작 그대로 */
  compose(text: string) {
    if (!this.composing) this.h.onCompositionStart();
    this.value = this.value.slice(
      0,
      this.value.length - this.composingText.length,
    );
    this.value += text;
    this.composingText = text;
    this.imeOwned = text;
    this.h.onInput();
  }

  /** 조합 없이 그냥 글자 입력 (영문) */
  typeAscii(ch: string) {
    this.value += ch;
    this.h.onInput();
  }

  /** IME가 조합을 확정한다.
   *  @returns 늦게 오는 input을 나중에 흘려보내는 함수 (없으면 null) */
  finishComposition(): (() => void) | null {
    if (!this.composing) return null;
    const data = this.composingText;
    this.composingText = "";
    if (this.order === "value-then-end") {
      this.h.onInput();
      this.h.onCompositionEnd({ data });
      return null;
    }
    // 확정 글자가 아직 value에 없는 채로 compositionend가 먼저 온다
    this.value = this.value.slice(0, this.value.length - data.length);
    this.h.onCompositionEnd({ data });
    return () => {
      this.value += data;
      this.h.onInput();
    };
  }

  /** 한글 한 단어를 친다. 음절이 넘어갈 때 앞 음절은 확정되고
   *  마지막 음절만 조합 중으로 남는다 — 실제 한글 IME 그대로. */
  typeWord(syllables: string[][]) {
    syllables.forEach((steps, i) => {
      for (const s of steps) this.compose(s);
      if (i < syllables.length - 1) this.finishComposition()?.();
    });
  }

  blur() {
    fakeDocument.activeElement = null;
    if (this.order === "blur-ignores") return; // 조합이 그대로 살아 있다
    this.finishComposition()?.();
    // 브라우저는 확정했지만 IME 엔진은 아직 자기 조합을 들고 있다(imeOwned).
  }

  focus() {
    fakeDocument.activeElement = this;
  }

  /** 윈도우 한글 IME는 Ctrl+Enter를 받으면 자기도 조합을 확정한다.
   *  keydown이 먼저 가고, 확정에 따른 input이 그 뒤에 온다. */
  imeCommitsOnEnter() {
    if (this.composing) {
      this.finishComposition()?.();
      this.imeOwned = "";
      return;
    }
    // 브라우저 쪽 조합은 이미 끝났는데 IME는 아직 들고 있었다
    // → 같은 음절이 한 번 더 들어간다 ("마지막 글자가 하나 더 붙는" 증상)
    if (this.imeOwned) {
      this.value += this.imeOwned;
      this.imeOwned = "";
      this.h.onInput();
    }
  }

  keydown(e: { key: string } & Record<string, unknown>) {
    this.defaultPrevented = false;
    this.h.onKeyDown({
      code: e.key === "Enter" ? "Enter" : undefined,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...e,
      nativeEvent: { isComposing: this.composing },
      preventDefault: () => {
        this.defaultPrevented = true;
      },
    });
  }
}
