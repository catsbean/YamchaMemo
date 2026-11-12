import { useEffect, useMemo, useRef, useState } from "react";
import { isImeEnter } from "../lib/ime";
import { matchLinkOptions, suggestKey } from "../lib/linkMatch";
import { linkOptions, type LinkOption } from "../lib/resolveLink";
import { useVault } from "../stores/vault";

export { suggestKey };

/** 추천을 띄울 최대 개수. 화면에는 여덟 줄쯤 보이고 나머지는 스크롤된다 —
 *  예전에는 여덟 개에서 잘라서, 아홉째부터는 글자를 더 쳐야만 닿을 수 있었다. */
const MAX = 30;

/** 커서 앞에서 `[[`로 시작해 아직 닫히지 않은 부분을 찾는다.
 *  `]` `|` `#` 줄바꿈이 끼면 링크가 이미 끝났거나 다른 문법이라 보지 않는다. */
const OPEN_LINK = /\[\[([^[\]|#\n]*)$/;

/** 커서 앞의 `[[…` 조각. 없으면 null */
function openLinkAt(el: HTMLTextAreaElement): { query: string; caret: number } | null {
  const caret = el.selectionStart ?? 0;
  const found = el.value.slice(0, caret).match(OPEN_LINK);
  return found ? { query: found[1], caret } : null;
}

/** 지금 열려 있는 `[[…` 조각을 가리키는 열쇠 — 시작 자리와 친 글자.
 *  같은 조각을 두고 `refresh`가 또 불렸는지 가리는 데 쓴다. */
export function contextKey(at: { query: string; caret: number }): string {
  return `${at.caret - at.query.length}:${at.query}`;
}

/** `refresh`가 할 일 — 닫을지, 그대로 둘지, 목록을 새로 잡을지.
 *
 *  `refresh`는 글자를 칠 때만이 아니라 **키에서 손을 뗄 때마다**(keyup) 불린다. 그때마다
 *  목록을 새로 잡으면 고른 자리도 맨 위로 돌아간다 — ↓로 한 칸 내려가도 손을 떼는 순간
 *  되돌아와서, 화살표로는 아무것도 고를 수 없었다. 조각이 그대로면 손대지 않는다. */
export function refreshAction(
  shownKey: string | null,
  at: { query: string; caret: number } | null,
): "close" | "keep" | "reset" {
  if (!at) return "close";
  return contextKey(at) === shownKey ? "keep" : "reset";
}

/** 고른 제목으로 `[[…`를 채운다 */
function insert(el: HTMLTextAreaElement, title: string) {
  const at = openLinkAt(el);
  if (!at) return;
  el.setRangeText(`${title}]]`, at.caret - at.query.length, at.caret, "end");
  // IME 훅이 placeholder를 다시 맞추도록 알린다 (값은 여기서 이미 바꿨다)
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
}

/** 질의에 맞는 후보들 — 규칙은 편집기와 같은 `matchLinkOptions` */
export function matches(options: LinkOption[], raw: string): LinkOption[] {
  return matchLinkOptions(options, raw, MAX);
}

/** 입력창에서 `[[`를 치면 노트 제목을 추천한다.
 *
 *  에디터(CodeMirror)에는 진작 있었는데 기록 입력창에는 없었다. 같은 `[[위키링크]]`
 *  문법을 쓰는 자리인데 한쪽만 도와주면, 사용자는 "여기선 되고 저기선 안 된다"를
 *  규칙으로 배울 수가 없다.
 *
 *  ## 왜 리스너를 직접 다는가
 *  이 입력창들은 IME 안전 규칙(`lib/ime.ts`)을 따른다 — 값은 DOM이 갖고, 타이핑
 *  중에는 부모가 다시 그려지면 안 된다. 그래서 추천 상태를 부모가 아니라 **이
 *  컴포넌트가** 들고, 입력창에는 네이티브 리스너로 붙는다. 다시 그려지는 건 이
 *  목록뿐이고 입력창은 건드리지 않는다.
 *
 *  키도 네이티브 단계에서 가로챈다. React는 리스너를 루트에 모아 다는데 입력창에
 *  직접 단 리스너가 그보다 먼저 돌므로, `stopPropagation()`으로 IME 상태 기계까지
 *  내려가는 것을 막을 수 있다. 조합 중 Enter는 **건드리지 않는다** — 그건 한글을
 *  확정하려는 Enter지 항목을 고르려는 Enter가 아니다.
 *
 *  부모는 이 컴포넌트를 `relative`인 칸 안에 두어야 목록이 입력창 아래에 붙는다. */
export default function WikiLinkSuggest({
  inputRef,
  options: given,
  placement = "absolute left-0 top-full mt-1 max-h-60",
}: {
  inputRef: { current: HTMLTextAreaElement | null };
  /** 후보를 직접 넘긴다 — 스토어를 초기화하지 않는 창(빠른 담기)을 위해서다.
   *  안 넘기면 스토어의 노트로 만든다. */
  options?: LinkOption[];
  /** 목록이 놓일 자리와 높이 (Tailwind 클래스). 기본은 입력창 바로 아래 */
  placement?: string;
}) {
  const notes = useVault((s) => s.notes);
  const schemas = useVault((s) => s.schemas);
  // 후보 목록은 노트가 바뀔 때만 다시 만든다. `refresh`는 keyup마다 도는데,
  // 거기서 매번 전체 노트를 훑으면 링크를 치는 내내 그 값을 문다.
  const stored = useMemo(() => linkOptions(notes, schemas), [notes, schemas]);
  const options = given ?? stored;
  const [items, setItems] = useState<LinkOption[]>([]);
  const [active, setActive] = useState(0);

  // 화살표로 내려가다 보이는 범위를 벗어나면 고른 줄을 따라 스크롤한다
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active, items]);

  // 네이티브 리스너가 최신 값을 보게 하는 거울 (리스너를 매번 다시 달지 않으려고)
  const latest = useRef({ items, active, options });
  latest.current = { items, active, options };

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;

    // Esc로 물린 상태. 글자를 더 치기 전까지는 다시 열지 않는다 —
    // 안 그러면 Esc의 keyup이 곧바로 refresh를 불러 방금 닫은 목록이 되살아난다.
    let dismissed = false;

    // 이미 닫혀 있으면 **같은 배열을 그대로 돌려준다**. `setItems([])`처럼 새 배열을
    // 만들면 React가 매번 값이 바뀐 것으로 보고 다시 그린다 — 추천이 뜰 일이 없는
    // 평범한 타이핑에서도 글자마다·keyup마다 그랬다. 이 입력창의 규칙은
    // "타이핑 중에는 리렌더가 없어야 한다"(lib/ime.ts 규칙 2)이므로 어기면 안 된다.
    // 지금 목록이 어느 `[[…` 조각을 보고 만든 것인지 (`contextKey`). 닫혀 있으면 null
    let shownKey: string | null = null;

    const close = () => {
      shownKey = null;
      setItems((cur) => (cur.length === 0 ? cur : []));
      setActive(0);
    };

    const refresh = () => {
      const target = inputRef.current;
      if (!target) return;
      const at = openLinkAt(target);
      const action = refreshAction(shownKey, at);
      if (action === "close" || !at) return close();
      if (dismissed) return;
      // 같은 조각이면 그대로 둔다 — 화살표로 고른 자리가 keyup에 되돌아가지 않게
      if (action === "keep") return;
      shownKey = contextKey(at);
      // 후보를 만드는 규칙은 에디터 자동완성과 같은 함수를 쓴다 (파일명·제목·별칭)
      setItems(matches(latest.current.options, at.query));
      setActive(0);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const list = latest.current.items;
      if (list.length === 0) return;
      const target = inputRef.current;
      if (!target) return;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      switch (suggestKey(e)) {
        case "ArrowDown":
          setActive((i) => (i + 1) % list.length);
          return stop();
        case "ArrowUp":
          setActive((i) => (i - 1 + list.length) % list.length);
          return stop();
        case "Escape":
          dismissed = true;
          close();
          return stop();
        case "Tab":
          insert(target, list[latest.current.active].insert);
          close();
          return stop();
        case "Enter":
          // Ctrl+Enter는 "추가"다 — 추천을 고르는 게 아니므로 그대로 흘려보낸다
          if (e.ctrlKey || e.metaKey) return;
          // 조합 중 Enter는 한글을 확정하려는 것이다. 가로채면 글자가 잘린다.
          if (isImeEnter({ nativeEvent: e, key: e.key })) return;
          insert(target, list[latest.current.active].insert);
          close();
          return stop();
      }
    };

    // 글자가 실제로 바뀌면 Esc로 물린 것을 푼다 (다시 도와줄 때가 됐다)
    const onInput = () => {
      dismissed = false;
      refresh();
    };

    // keyup까지 보는 이유: 화살표·Home/End로 커서만 옮겨도 문맥이 달라진다
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("input", onInput);
    el.addEventListener("keyup", refresh);
    el.addEventListener("click", refresh);
    el.addEventListener("blur", close);
    return () => {
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("input", onInput);
      el.removeEventListener("keyup", refresh);
      el.removeEventListener("click", refresh);
      el.removeEventListener("blur", close);
    };
  }, [inputRef]);

  if (items.length === 0) return null;

  return (
    <ul
      ref={listRef}
      className={`${placement} z-30 w-80 overflow-y-auto rounded border border-neutral-300 bg-white py-1 shadow-lg dark:border-neutral-600 dark:bg-neutral-800`}
    >
      {items.map((o, i) => (
        <li key={`${o.label} ${o.insert}`}>
          <button
            className={`flex w-full items-center gap-2 px-3 py-1 text-left text-sm ${
              i === active
                ? "bg-sky-100 dark:bg-sky-900"
                : "hover:bg-neutral-100 dark:hover:bg-neutral-700"
            }`}
            // mousedown을 막아야 입력창이 blur되지 않는다 (blur는 목록을 닫는다)
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const el = inputRef.current;
              // insert가 알리는 `input`이 refresh → close를 불러 목록을 닫는다
              if (el) insert(el, o.insert);
              else setItems([]);
            }}
          >
            <span className="truncate">{o.label}</span>
            {o.detail && (
              <span className="ml-auto shrink-0 text-2xs text-neutral-400">
                {o.detail}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
