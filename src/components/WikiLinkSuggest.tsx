import { useEffect, useRef, useState } from "react";
import { isImeEnter } from "../lib/ime";
import { useVault } from "../stores/vault";

/** 추천을 띄울 최대 개수 */
const MAX = 8;

/** 커서 앞에서 `[[`로 시작해 아직 닫히지 않은 부분을 찾는다.
 *  `]` `|` `#` 줄바꿈이 끼면 링크가 이미 끝났거나 다른 문법이라 보지 않는다. */
const OPEN_LINK = /\[\[([^[\]|#\n]*)$/;

/** 커서 앞의 `[[…` 조각. 없으면 null */
function openLinkAt(el: HTMLTextAreaElement): { query: string; caret: number } | null {
  const caret = el.selectionStart ?? 0;
  const found = el.value.slice(0, caret).match(OPEN_LINK);
  return found ? { query: found[1], caret } : null;
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

/** 질의에 맞는 제목들. 앞부터 맞는 것을 위로 —
 *  `역사적`이면 `역사적 예수`가 `한국의 역사적 인물`보다 먼저 와야 한다. */
export function matches(titles: string[], raw: string): string[] {
  const query = raw.trim().toLowerCase();
  const hit = query
    ? titles.filter((t) => t.toLowerCase().includes(query))
    : [...titles];
  hit.sort((a, b) => {
    const ai = a.toLowerCase().startsWith(query) ? 0 : 1;
    const bi = b.toLowerCase().startsWith(query) ? 0 : 1;
    return ai - bi || a.localeCompare(b, "ko");
  });
  return hit.slice(0, MAX);
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
}: {
  inputRef: { current: HTMLTextAreaElement | null };
}) {
  const notes = useVault((s) => s.notes);
  const [items, setItems] = useState<string[]>([]);
  const [active, setActive] = useState(0);

  // 네이티브 리스너가 최신 값을 보게 하는 거울 (리스너를 매번 다시 달지 않으려고)
  const latest = useRef({ items, active, notes });
  latest.current = { items, active, notes };

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;

    // Esc로 물린 상태. 글자를 더 치기 전까지는 다시 열지 않는다 —
    // 안 그러면 Esc의 keyup이 곧바로 refresh를 불러 방금 닫은 목록이 되살아난다.
    let dismissed = false;

    const close = () => {
      setItems([]);
      setActive(0);
    };

    const refresh = () => {
      const target = inputRef.current;
      if (!target) return;
      const at = openLinkAt(target);
      if (!at) return close();
      if (dismissed) return;
      // 파일명이 곧 링크 대상이다 (에디터의 자동완성과 같은 기준)
      const titles = latest.current.notes
        .map((n) => n.rel_path.split("/").pop()?.replace(/\.md$/, "") ?? n.title)
        .filter(Boolean);
      setItems(matches(titles, at.query));
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
      switch (e.key) {
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
          insert(target, list[latest.current.active]);
          close();
          return stop();
        case "Enter":
          // Ctrl+Enter는 "추가"다 — 추천을 고르는 게 아니므로 그대로 흘려보낸다
          if (e.ctrlKey || e.metaKey) return;
          // 조합 중 Enter는 한글을 확정하려는 것이다. 가로채면 글자가 잘린다.
          if (isImeEnter({ nativeEvent: e, key: e.key })) return;
          insert(target, list[latest.current.active]);
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
    <ul className="absolute left-0 top-full z-30 mt-1 max-h-60 w-80 overflow-y-auto rounded border border-neutral-300 bg-white py-1 shadow-lg dark:border-neutral-600 dark:bg-neutral-800">
      {items.map((title, i) => (
        <li key={title}>
          <button
            className={`block w-full truncate px-3 py-1 text-left text-sm ${
              i === active
                ? "bg-sky-100 dark:bg-sky-900"
                : "hover:bg-neutral-100 dark:hover:bg-neutral-700"
            }`}
            // mousedown을 막아야 입력창이 blur되지 않는다 (blur는 목록을 닫는다)
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const el = inputRef.current;
              if (el) insert(el, title);
              setItems([]);
            }}
          >
            {title}
          </button>
        </li>
      ))}
    </ul>
  );
}
