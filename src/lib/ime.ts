import { useRef } from "react";

type InputEl = HTMLInputElement | HTMLTextAreaElement;

/** 조합 중에는 placeholder를 감추는 클래스 (styles.css) */
const HIDE_PLACEHOLDER = "ime-composing";

/** 이 Enter가 "한글 조합을 확정하려고" 누른 것인지.
 *
 *  조합 중 Enter는 글자를 완성하려는 것이지 동작을 시키려는 게 아니다.
 *  그대로 실행하면 덜 쓴 검색어로 검색되거나 노트가 먼저 만들어진다.
 *  윈도우 IME는 이때 키를 `VK_PROCESSKEY`(229)로 가려 보내기도 해서 함께 본다.
 *
 *  값을 직접 들고 있는 입력창(`useImeInput`)이 아니라, React state로 값을 묶은
 *  평범한 입력창에서 Enter로 동작을 실행할 때 앞에 두고 걸러 낸다. */
export function isImeEnter(e: {
  nativeEvent: { isComposing?: boolean; keyCode?: number };
  key: string;
}): boolean {
  return (
    e.nativeEvent.isComposing === true ||
    e.key === "Process" ||
    e.nativeEvent.keyCode === 229
  );
}

/** 한글 입력(IME)에서 안전한 입력창을 만드는 훅.
 *
 *  ## 규칙 1 — 값은 DOM이 소유한다 (uncontrolled)
 *  `value={state}`로 묶으면 조합 중 React가 DOM 값을 자기 상태로 되돌려 써서
 *  조합 중이던 글자가 사라진다. `defaultValue`만 주고 ref로 읽는다.
 *
 *  ## 규칙 2 — 타이핑 중에는 리렌더가 없어야 한다
 *  글자마다 `setState`를 부르면(예: 버튼 활성화용 빈칸 검사) 그 리렌더가 조합을
 *  건드린다. 그래서 이 훅을 쓰는 입력창에는 `onChange`를 달지 않는다.
 *
 *  ## 규칙 3 — 조합 중이면 IME가 끝내게 두고, 글자가 들어온 뒤에 읽는다
 *  조합 중 Enter를 눌렀을 때가 까다롭다. 조합이 확정되는 시점과 확정된 글자가
 *  value에 들어오는 시점이 어긋나서, 그 사이에 값을 읽으면 글자가 잘린다.
 *  시간(setTimeout)으로 맞추려 하면 깨진다. 확정된 글자가 실제로 들어오는
 *  순간은 `input` 이벤트이므로 그 신호를 기다렸다 보낸다.
 *
 *  이때 **조합을 우리가 억지로 끝내면 안 된다.** Ctrl+Enter는 IME도 조합을
 *  확정시키는 키라서, 우리가 blur로 한 번 더 확정시키면 같은 음절이 두 번
 *  들어간다(마지막 글자가 하나 더 붙었다 사라지는 증상).
 *  그래서 blur 확정은 `input`이 끝내 오지 않을 때의 최후 수단으로만 쓴다 —
 *  [추가] 버튼이 멀쩡했던 이유(클릭 = 포커스 이동 = 확정)를 그때만 빌려 온다. */
export function useImeInput<T extends InputEl = HTMLInputElement>(
  onSubmit: (value: string) => void,
  mode: "enter" | "ctrl-enter" = "enter",
  onEscape?: () => void,
) {
  const ref = useRef<T | null>(null);
  // 콜백·모드는 매 렌더 최신값을 쓰되(오래된 클로저 방지), 상태 기계는 한 번만 만든다
  const opts = useRef({ onSubmit, mode, onEscape });
  opts.current = { onSubmit, mode, onEscape };
  const core = useRef<ImeCore<T> | null>(null);
  if (!core.current) core.current = createImeCore<T>(ref, () => opts.current);
  return core.current;
}

export type ImeCore<T extends InputEl> = ReturnType<typeof createImeCore<T>>;

/** 훅에서 React를 걷어낸 알맹이 — 상태 기계 그 자체.
 *  React 없이 그대로 돌릴 수 있어서 IME 이벤트 순서를 테스트로 고정할 수 있다.
 *  (`src/lib/ime.test.ts`가 이 함수를 직접 돌린다) */
export function createImeCore<T extends InputEl>(
  ref: { current: T | null },
  getOpts: () => {
    onSubmit: (value: string) => void;
    mode: "enter" | "ctrl-enter";
    onEscape?: () => void;
  },
) {
  const composing = { current: false };
  // 조합은 끝났는데 확정된 글자가 아직 value에 안 들어온 구간
  const settling = { current: false };
  const pending = { current: false };
  const timer: { current: ReturnType<typeof setTimeout> | undefined } = {
    current: undefined,
  };

  const fire = () => {
    const el = ref.current;
    if (el) getOpts().onSubmit(el.value);
  };

  /** 예약된 제출을 실행 (조합이 확정돼 값이 들어온 뒤) */
  const flush = () => {
    clearTimeout(timer.current);
    if (!pending.current) return;
    pending.current = false;
    fire();
  };

  /** 조합 중이던 글자를 확정시킨다. 포커스가 빠지는 순간 브라우저가 조합을
   *  그 자리에서 확정하므로, 되돌려 받은 포커스와 함께 완성된 value가 남는다.
   *  IME가 스스로 확정하지 않을 때만 쓴다 — 겹치면 글자가 두 번 들어간다. */
  const commitComposition = (el: T) => {
    if (!composing.current) return;
    const refocus = document.activeElement === el;
    el.blur();
    if (refocus) el.focus();
  };

  /** 조합 중에는 placeholder를 감춘다. 브라우저가 조합 글자를 지웠다 다시 넣는
   *  사이사이 값을 빈 것으로 보고 placeholder를 깜빡이게 하는 걸 막는다.
   *  (깜빡임은 화면만의 문제고 값 자체는 멀쩡하다)
   *  주의: 이 훅을 쓰는 입력창의 `className`은 고정 문자열이어야 한다. 값이
   *  바뀌면 React가 class를 통째로 다시 써서 여기서 붙인 표시가 날아간다. */
  const syncPlaceholder = (el: T) => {
    el.classList.toggle(HIDE_PLACEHOLDER, composing.current || el.value !== "");
  };

  return {
    value: () => ref.current?.value ?? "",
    clear: () => {
      const el = ref.current;
      if (!el) return;
      // 조합이 살아 있는 채로 비우면 IME가 남은 글자를 빈 칸에 다시 밀어 넣는다
      commitComposition(el);
      el.value = "";
      settling.current = false;
      pending.current = false;
      clearTimeout(timer.current);
      syncPlaceholder(el);
    },
    /** 입력창에 그대로 펼친다. value·onChange는 함께 넘기지 말 것. */
    handlers: {
      ref,
      onCompositionStart: () => {
        composing.current = true;
        if (ref.current) syncPlaceholder(ref.current);
      },
      onCompositionEnd: (e: React.CompositionEvent<T>) => {
        composing.current = false;
        // 확정된 글자(e.data)가 value에 이미 들어왔는지 본다. 아직이면 이 틈에
        // 값을 읽으면 안 되고 `input`을 기다려야 한다 — 시간이 아니라 값으로 판단.
        settling.current = !!e.data && !ref.current?.value.endsWith(e.data);
        if (ref.current) syncPlaceholder(ref.current);
      },
      // 조합이 확정돼 글자가 실제로 들어온 순간 — 예약된 제출을 여기서 처리한다
      onInput: () => {
        settling.current = false;
        if (ref.current) syncPlaceholder(ref.current);
        if (pending.current) flush();
      },
      onKeyDown: (e: React.KeyboardEvent<T>) => {
        const { mode, onEscape } = getOpts();
        if (e.key === "Escape" && onEscape) {
          e.preventDefault();
          onEscape();
          return;
        }
        // 조합 중에는 브라우저가 key를 "Process"로 가리기도 해서 물리 키도 본다
        const enter =
          e.key === "Enter" || e.code === "Enter" || e.code === "NumpadEnter";
        if (!enter) return;
        const trigger =
          mode === "ctrl-enter" ? e.ctrlKey || e.metaKey : !e.shiftKey;
        if (!trigger) return;
        const el = ref.current;
        if (!el) return;

        if (composing.current || settling.current) {
          // 조합이 아직 안 끝났거나 확정 글자가 value에 안 들어왔다.
          // blur로 억지로 확정시키면 IME의 확정과 겹쳐 같은 음절이 두 번
          // 들어간다 — 그건 하지 않고 IME에게 맡겨 `input`을 기다린다.
          // 하지만 preventDefault는 반드시 부른다. 안 부르면 브라우저가 이
          // Enter의 기본 동작(줄바꿈 삽입)을 그대로 실행해 버려서, 조합이
          // 끝나며 확정 글자가 들어오는 시점과 뒤섞여 값이 망가질 수 있다.
          e.preventDefault();
          pending.current = true;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            // 끝내 안 왔다 — 그때만 포커스를 빼서 확정시키고 보낸다
            if (!pending.current) return;
            commitComposition(el);
            flush();
          }, 120);
          return;
        }
        e.preventDefault();
        fire();
      },
    },
  };
}
