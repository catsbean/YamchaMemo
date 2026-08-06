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
 *  [추가] 버튼이 멀쩡했던 이유(클릭 = 포커스 이동 = 확정)를 그때만 빌려 온다.
 *
 *  ## 규칙 4 — 조합 이벤트를 아예 안 쓰는 IME도 있다
 *  위 규칙들은 모두 "조합 중"이라는 상태가 있다고 보고 세운 것이다. 그런데 윈도우
 *  한글 IME 중에는 `compositionstart/end`를 한 번도 내지 않고 음절을 곧바로 확정해
 *  넣는 것이 있다 — 고쳐 쓸 때는 **지웠다 다시 넣는다**. Ctrl이 눌려 있으면 그
 *  백스페이스가 브라우저에서 "단어 통째 지우기"가 되어 앞 글자까지 날아간다
 *  (`기록` + Ctrl+Enter → `록`만 저장). `isComposing`을 아무리 잘 봐도 이 경로는
 *  안 보인다. 그래서 `repaired()`가 따로 지켜본다. */
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

  // ── Ctrl을 누른 채 IME가 단어를 삼키는 것 지켜보기 ──
  // Ctrl을 누른 순간의 값. 이 뒤에 IME가 단어를 지웠다 다시 쓰면 여기로 되돌린다.
  const ctrlValue: { current: string | null } = { current: null };
  const ateWord = { current: false };
  const reinserted = { current: false };

  const forgetCtrl = () => {
    ctrlValue.current = null;
    ateWord.current = false;
    reinserted.current = false;
  };

  /** IME가 삼킨 단어를 되돌린 값. 삼킨 적이 없으면 null.
   *
   *  ## 무엇을 되돌리는가
   *  윈도우 한글 IME 중에는 조합 이벤트를 전혀 쓰지 않고 **지웠다 다시 넣는**
   *  방식으로 음절을 고쳐 쓰는 것이 있다. 평소에는 한 글자씩 지우니 티가 안 난다.
   *  그런데 Ctrl이 눌려 있으면 그 백스페이스가 브라우저에서 "단어 통째 지우기"
   *  (`deleteWordBackward`)가 되어 **앞 글자까지 함께 날아간다**. 그러고 나서 IME는
   *  자기가 들고 있던 마지막 음절 하나만 다시 넣는다.
   *  `기록` + Ctrl+Enter → 입력창에 `록`만 남은 채로 발사된다.
   *
   *  ## 왜 막지 않고 되돌리는가
   *  그 순간만 보면 IME가 보낸 백스페이스와 사람이 누른 Ctrl+Backspace가 완전히
   *  똑같다 (`key: "Backspace"`, `ctrlKey: true`). 그 자리에서 막으면 사람이 일부러
   *  누른 단어 지우기까지 함께 막힌다.
   *  둘은 **그 다음**에 갈린다 — IME는 지운 자리에 곧바로 글자를 다시 넣고, 사람은
   *  Ctrl을 쥔 채로 글자를 넣을 방법이 없다. 그래서 "지웠다 + 다시 넣었다"가 모두
   *  보였을 때만 되돌린다. */
  const repaired = (): string | null =>
    ateWord.current && reinserted.current ? ctrlValue.current : null;

  const fire = () => {
    const el = ref.current;
    if (!el) return;
    getOpts().onSubmit(repaired() ?? el.value);
    forgetCtrl();
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

  /** 글자를 지웠다 다시 넣는 사이에 안내 문구가 되살아나지 않도록 기다리는 시간.
   *  실측한 IME의 지우기→다시 넣기 간격은 30~40ms였다. 넉넉히 잡되, 진짜로 다 지웠을
   *  때 문구가 돌아오는 게 굼떠 보이지 않을 만큼만. */
  const PLACEHOLDER_GRACE_MS = 150;
  const placeholderTimer: { current: ReturnType<typeof setTimeout> | undefined } =
    { current: undefined };

  /** 값이 있는 동안 placeholder를 감춘다.
   *
   *  ## 왜 되살릴 때만 뜸을 들이는가
   *  한글 IME는 음절을 고칠 때마다 **글자를 지웠다 다시 넣는다**. 첫 음절을 쓰는
   *  동안에는 그 사이 값이 통째로 빈 칸이 된다 — 실측: `기록` 한 단어에 3번, 매번
   *  30~40ms. 그때마다 안내 문구를 곧바로 되살리면 글자마다 번쩍인다.
   *  값이 생기는 쪽은 즉시 감추고(늦으면 문구와 글자가 겹쳐 보인다), 비는 쪽만
   *  한 박자 기다렸다가 **그때도 여전히 비어 있을 때만** 되살린다.
   *
   *  주의: 이 훅을 쓰는 입력창의 `className`은 고정 문자열이어야 한다. 값이
   *  바뀌면 React가 class를 통째로 다시 써서 여기서 붙인 표시가 날아간다. */
  const syncPlaceholder = (el: T) => {
    clearTimeout(placeholderTimer.current);
    if (composing.current || el.value !== "") {
      el.classList.toggle(HIDE_PLACEHOLDER, true);
      return;
    }
    placeholderTimer.current = setTimeout(() => {
      const now = ref.current;
      if (now && !composing.current && now.value === "") {
        now.classList.toggle(HIDE_PLACEHOLDER, false);
      }
    }, PLACEHOLDER_GRACE_MS);
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
      forgetCtrl();
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
      onInput: (e?: { nativeEvent?: { inputType?: string } }) => {
        settling.current = false;
        // Ctrl을 쥔 사이에 일어난 일만 본다 (평소 타이핑에는 아무 영향이 없다)
        if (ctrlValue.current !== null) {
          const how = e?.nativeEvent?.inputType;
          if (how === "deleteWordBackward" || how === "deleteWordForward") {
            ateWord.current = true;
          } else if (ateWord.current && how === "insertText") {
            reinserted.current = true;
          }
        }
        if (ref.current) syncPlaceholder(ref.current);
        if (pending.current) flush();
      },
      // Ctrl에서 손을 뗄 때 — 보내지 않고 그냥 놓았어도 입력창은 성해야 한다
      onKeyUp: (e: React.KeyboardEvent<T>) => {
        if (e.key !== "Control" && e.key !== "Meta") return;
        const el = ref.current;
        const back = repaired();
        if (el && back !== null && el.value !== back) {
          el.value = back;
          syncPlaceholder(el);
        }
        forgetCtrl();
      },
      onKeyDown: (e: React.KeyboardEvent<T>) => {
        const { mode, onEscape } = getOpts();
        // Ctrl을 누른 순간의 값을 붙잡아 둔다 (IME가 이 뒤에 단어를 삼킬 수 있다).
        // 눌린 채 반복해서 들어오므로 첫 번째만 찍는다.
        if (e.key === "Control" || e.key === "Meta") {
          if (ctrlValue.current === null && ref.current) {
            ctrlValue.current = ref.current.value;
          }
          return;
        }
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
