import { isImeEnter } from "./ime";

/** 값을 가르는 글자 — 쉼표와 줄바꿈.
 *  줄바꿈까지 보는 것은 표에서 복사한 여러 줄을 한 번에 붙여넣게 하려는 것이다. */
const SEPARATOR = /[,\n\r]/;

/** 조합 중에는 placeholder를 감추는 클래스 (styles.css) */
const HIDE_PLACEHOLDER = "ime-composing";

/** 글자를 지웠다 다시 넣는 사이에 안내 문구가 되살아나지 않도록 기다리는 시간.
 *  까닭은 `ime.ts`의 `syncPlaceholder`에 적어 두었다 — 한글 IME는 음절을 고칠 때마다
 *  값을 통째로 비웠다 다시 쓴다. */
const PLACEHOLDER_GRACE_MS = 150;

/** 조합이 끝났는데 확정된 글자가 끝내 안 들어올 때, 포기하고 확정시키기까지의 시간 */
const SETTLE_TIMEOUT_MS = 120;

/** 한 덩어리 문자열을 값 목록으로 — 앞뒤 공백을 다듬고 빈 조각은 버린다 */
export function splitEntries(raw: string): string[] {
  return raw
    .split(SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 뒤에 이어 붙이되 이미 있는 값은 조용히 넘긴다.
 *  같은 태그·별칭을 두 번 적는 것은 실수이지 뜻이 아니라서, 막아서 알리기보다
 *  그냥 하나로 두는 편이 손이 덜 간다. */
export function mergeEntries(items: string[], add: string[]): string[] {
  const seen = new Set(items);
  const out = [...items];
  for (const a of add) {
    if (seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

export type ListCore = ReturnType<typeof createListCore>;

/**
 * 값 여러 개를 칩으로 담는 입력칸의 알맹이 — React를 걷어낸 상태 기계.
 *
 * ## 왜 값을 React에 묶지 않는가
 * 앞선 구현은 `value={items.join(", ")}` + `onChange`에서 곧바로 쪼개 담는
 * **통제 입력**이었다. 쉼표를 치는 순간 `"가,"`가 `["가"]`로 정규화돼 되돌아와서,
 * React가 DOM 값을 `"가"`로 되돌려 썼다. 쉼표가 찍히자마자 지워지니 두 번째 값을
 * 시작할 방법 자체가 없었다. 뒤따르는 공백도 `trim()`에 같이 먹혔다.
 *
 * 그래서 **입력칸의 값은 DOM이 소유한다**(`ime.ts` 규칙 1과 같은 이유 — 조합 중
 * React가 값을 되돌려 쓰면 한글이 깨진다). 확정된 값만 배열로 위에 올려 보낸다.
 *
 * ## 확정하는 순간
 * - 쉼표·줄바꿈이 들어오면 그 앞을 칩으로 옮기고 꼬리만 입력칸에 남긴다 (`absorb`)
 * - Enter — 단, **조합 중 Enter는 글자를 확정하려는 것**이라 그대로 실행하면 안 된다
 * - 포커스가 빠질 때 (`onBlur`) — 적어 두고 그냥 저장을 눌러도 잃지 않게
 *
 * ## 조합 중 Enter
 * `compositionend`가 온 뒤에도 확정된 글자가 `value`에 아직 안 들어온 구간이 있다
 * (`settling`). 그 틈에 값을 읽으면 마지막 음절이 잘린다. 시간으로 맞추면 깨지므로
 * 글자가 실제로 들어오는 `input`을 기다렸다 확정한다. `ime.ts`와 같은 방식이고,
 * 같은 시뮬레이터(`ime.sim.ts`)로 순서를 바꿔 가며 검증한다.
 */
export function createListCore(
  ref: { current: HTMLInputElement | null },
  getOpts: () => { items: string[]; onChange: (next: string[]) => void },
) {
  const composing = { current: false };
  /** 조합은 끝났는데 확정된 글자가 아직 value에 안 들어온 구간 */
  const settling = { current: false };
  /** 조합이 끝나면 확정하기로 예약된 Enter */
  const pending = { current: false };
  const timer: { current: ReturnType<typeof setTimeout> | undefined } = {
    current: undefined,
  };
  const placeholderTimer: {
    current: ReturnType<typeof setTimeout> | undefined;
  } = { current: undefined };

  /** 값이 있는 동안 placeholder를 감춘다 (되살릴 때만 한 박자 기다린다) */
  const syncPlaceholder = (el: HTMLInputElement) => {
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

  const push = (add: string[]) => {
    if (add.length === 0) return;
    const { items, onChange } = getOpts();
    const next = mergeEntries(items, add);
    // 전부 이미 있던 값이면 위를 건드리지 않는다 (쓸데없는 저장 표시를 안 만든다)
    if (next.length !== items.length) onChange(next);
  };

  /** 입력칸에 쌓인 글자 중 **구분자 앞쪽**만 칩으로 옮긴다. 치는 중인 꼬리는 남긴다. */
  const absorb = () => {
    const el = ref.current;
    if (!el || !SEPARATOR.test(el.value)) return;
    const parts = el.value.split(SEPARATOR);
    el.value = parts.pop() ?? "";
    syncPlaceholder(el);
    push(parts.map((s) => s.trim()).filter(Boolean));
  };

  /** 입력칸에 남은 것을 통째로 확정한다 (Enter·포커스 이탈) */
  const commitDraft = () => {
    const el = ref.current;
    if (!el) return;
    const parts = splitEntries(el.value);
    el.value = "";
    syncPlaceholder(el);
    push(parts);
  };

  const flush = () => {
    clearTimeout(timer.current);
    if (!pending.current) return;
    pending.current = false;
    commitDraft();
  };

  /** 조합 중이던 글자를 확정시킨다 — IME가 스스로 끝내지 않을 때의 최후 수단.
   *  겹쳐 부르면 같은 음절이 두 번 들어간다 (`ime.ts` 규칙 3). */
  const commitComposition = (el: HTMLInputElement) => {
    if (!composing.current) return;
    const refocus =
      typeof document !== "undefined" && document.activeElement === el;
    el.blur();
    if (refocus) el.focus();
  };

  return {
    /** 입력칸에 그대로 펼친다. `value`·`onChange`는 함께 넘기지 말 것 —
     *  값을 React가 소유하는 순간 이 칸이 고치려던 병이 되돌아온다. */
    handlers: {
      ref,
      onCompositionStart: () => {
        composing.current = true;
        if (ref.current) syncPlaceholder(ref.current);
      },
      onCompositionEnd: (e: { data: string }) => {
        composing.current = false;
        // 확정된 글자가 value에 이미 들어왔는지 값으로 판단한다 (시간이 아니라)
        settling.current = !!e.data && !ref.current?.value.endsWith(e.data);
        if (ref.current) syncPlaceholder(ref.current);
        if (!settling.current) absorb();
      },
      onInput: () => {
        settling.current = false;
        if (ref.current) syncPlaceholder(ref.current);
        // 예약된 Enter가 있으면 그쪽이 값을 통째로 가져간다 —
        // 여기서 absorb까지 하면 한 이벤트에 위를 두 번 갱신하게 되고,
        // 두 번째는 아직 반영 안 된 옛 배열 위에 얹혀 앞의 값을 지운다.
        if (pending.current) {
          flush();
          return;
        }
        if (!composing.current) absorb();
      },
      onKeyDown: (e: {
        key: string;
        code?: string;
        shiftKey?: boolean;
        nativeEvent: { isComposing?: boolean; keyCode?: number };
        preventDefault: () => void;
      }) => {
        if (e.key === "Backspace") {
          const el = ref.current;
          if (!el || el.value !== "" || composing.current) return;
          const { items, onChange } = getOpts();
          const last = items[items.length - 1];
          if (last === undefined) return;
          // 지우지 않고 되돌려 놓는다. 칩은 한 번 만들면 고칠 길이 없어서,
          // 오타 하나에 지우고 다시 치게 하는 대신 이어서 고치게 둔다.
          e.preventDefault();
          el.value = last;
          syncPlaceholder(el);
          onChange(items.slice(0, -1));
          return;
        }
        const enter =
          e.key === "Enter" || e.code === "Enter" || e.code === "NumpadEnter";
        if (!enter || e.shiftKey) return;
        // 이 칸에서 Enter는 "값 하나 확정"이다. 막지 않으면 감싼 대화상자가
        // 이 Enter를 저장으로 알아듣고 먼저 닫힌다.
        e.preventDefault();
        if (composing.current || settling.current || isImeEnter(e)) {
          // 조합을 우리가 억지로 끝내지 않는다 — IME의 확정과 겹치면 음절이
          // 두 번 들어간다. 글자가 들어오는 `input`을 기다렸다 확정한다.
          pending.current = true;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            if (!pending.current) return;
            const el = ref.current;
            if (el) commitComposition(el);
            flush();
          }, SETTLE_TIMEOUT_MS);
          return;
        }
        commitDraft();
      },
      onBlur: () => {
        clearTimeout(timer.current);
        pending.current = false;
        commitDraft();
      },
    },
  };
}
