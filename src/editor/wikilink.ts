// [[위키링크]] — 마크다운 인라인 파서 확장 + Ctrl+클릭 이동 + 자동완성

import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionStatus,
  currentCompletions,
  moveCompletionSelection,
  setSelectedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { Prec, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";
import { matchLinkOptions, suggestKey } from "../lib/linkMatch";
import { newNoteOption } from "../lib/linkStubs";
import { plainLinkMatch, plainLinkSuggestOn } from "../lib/plainLink";
import type { LinkOption } from "../lib/resolveLink";

/** 편집기 자동완성이 한 번에 내놓는 최대 개수 (목록은 스크롤된다) */
const EDITOR_MAX = 50;

const OPEN = 91; // [
const CLOSE = 93; // ]
const NEWLINE = 10;

/** `[[타깃|표시]]`를 WikiLink 노드로 파싱하는 lezer-markdown 확장 */
export const wikiLinkMarkdown: MarkdownConfig = {
  defineNodes: [
    { name: "WikiLink", style: tags.link },
    { name: "WikiLinkMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "WikiLink",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== OPEN || cx.char(pos + 1) !== OPEN) return -1;
        for (let i = pos + 2; i < cx.end - 1; i++) {
          const ch = cx.char(i);
          if (ch === NEWLINE) return -1;
          if (ch === CLOSE && cx.char(i + 1) === CLOSE) {
            if (i === pos + 2) return -1; // [[]] 빈 링크
            return cx.addElement(
              cx.elt("WikiLink", pos, i + 2, [
                cx.elt("WikiLinkMark", pos, pos + 2),
                cx.elt("WikiLinkMark", i, i + 2),
              ]),
            );
          }
        }
        return -1;
      },
    },
  ],
};

/** 문서 위치가 WikiLink 안이면 타깃 제목을 반환 */
export function wikiLinkTargetAt(view: EditorView, pos: number): string | null {
  const tree = syntaxTree(view.state);
  let node = tree.resolveInner(pos, 0);
  while (node.parent && node.name !== "WikiLink") node = node.parent;
  if (node.name !== "WikiLink") return null;
  const raw = view.state.sliceDoc(node.from + 2, node.to - 2);
  const target = raw.split("|")[0].split("#")[0].trim();
  return target || null;
}

/** Ctrl(⌘)+클릭으로 위키링크 이동 */
export function wikiLinkClick(onNavigate: (target: string) => void) {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!(event.ctrlKey || event.metaKey)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const target = wikiLinkTargetAt(view, pos);
      if (!target) return false;
      event.preventDefault();
      onNavigate(target);
      return true;
    },
  });
}

/** `[[` 입력 시 노트 이름 자동완성 (파일명·제목·별칭).
 *
 *  후보를 만드는 규칙은 `lib/resolveLink.ts`의 `linkOptions`가 갖고 있다 —
 *  이름이 겹치면 폴더까지 넣어 주므로, 넣는 글자(`insert`)가 보이는 이름과 다를 수 있다. */
export function wikiLinkCompletion(getOptions: () => LinkOption[]) {
  function source(context: CompletionContext): CompletionResult | null {
    const match = context.matchBefore(/\[\[([^\]|#\n]*)$/);
    if (!match) return null;
    const from = match.from + 2;
    // 고르기·줄 세우기를 CodeMirror에 맡기지 않는다(`filter: false`) — 기록 입력창과
    // 같은 답을 내려고 `matchLinkOptions`를 직접 돌린다. `validFor`를 주지 않으므로
    // 글자를 칠 때마다 이 함수가 다시 불린다.
    const query = context.state.sliceDoc(from, context.pos);
    const all = getOptions();
    const options = matchLinkOptions(all, query, EDITOR_MAX).map(completionOf);
    // 맞는 이름이 없으면 "이 이름으로 새 글" 줄을 끝에 붙인다 (자동 만들기가 켜져 있을 때)
    const fresh = newNoteOption(query, all);
    if (fresh) options.push(completionOf(fresh));
    return { from, filter: false, options };
  }

  // 같은 후보에는 **같은 객체**를 돌려준다. CodeMirror는 목록을 새로 받을 때 고른 줄을
  // 객체가 같은지로 찾아 이어 간다 — 매번 새로 만들면, 화살표로 내려간 뒤 한글 조합이
  // 확정되는 것만으로(글자는 그대로인데 문서는 바뀐 것으로 친다) 맨 위로 되돌아간다.
  const made = new Map<string, Completion>();
  function completionOf(o: LinkOption): Completion {
    const key = `${o.label}\u0000${o.insert}\u0000${o.detail}`;
    let c = made.get(key);
    if (!c) {
      c = {
        label: o.label,
        detail: o.detail || undefined,
        type: "text",
        apply: `${o.insert}]]`,
      };
      made.set(key, c);
    }
    return c;
  }
  // ── `[[` 없이 쓰다가: 글 이름을 치면 링크로 바꿔 주겠냐고 추천한다 (설정에서 켠 사람만) ──
  // 규칙은 `lib/plainLink.ts`. 여기서는 줄 밖을 봐야 아는 자리(코드 블록 등)를 구문 트리로 거른다.
  function plainSpot(state: EditorState, pos: number) {
    if (!plainLinkSuggestOn()) return null;
    const line = state.doc.lineAt(pos);
    // 낱말 한가운데를 고치는 중이면 끼어들지 않는다 (커서 뒤에 글자가 붙어 있다)
    if (/\S/.test(line.text[pos - line.from] ?? "")) return null;
    for (let n: { name: string; parent: unknown } | null = syntaxTree(state).resolveInner(pos, -1); n; ) {
      if (PLAIN_BLOCKED.test(n.name)) return null;
      n = n.parent as { name: string; parent: unknown } | null;
    }
    const hit = plainLinkMatch(getOptions(), line.text.slice(0, pos - line.from), PLAIN_MAX);
    return hit ? { from: line.from + hit.from, typed: hit.typed, options: hit.options } : null;
  }

  function plainSource(context: CompletionContext): CompletionResult | null {
    const spot = plainSpot(context.state, context.pos);
    if (!spot) return null;
    return { from: spot.from, filter: false, options: spot.options.map(plainCompletionOf) };
  }

  const plainMade = new Map<string, Completion>();
  function plainCompletionOf(o: LinkOption): Completion {
    const key = `${o.label}\u0000${o.insert}\u0000${o.detail}`;
    let c = plainMade.get(key);
    if (!c) {
      c = { label: o.label, detail: o.detail || undefined, type: PLAIN_TYPE, apply: `[[${o.insert}]]` };
      plainMade.set(key, c);
    }
    return c;
  }

  // 그 목록은 **아무것도 골라 두지 않은 채** 뜬다. 청하지 않은 추천이 Enter를 가로채면 줄을
  // 바꾸려다 링크가 들어간다. CodeMirror는 첫 줄을 골라 둔 채로 여는 것밖에 몰라서,
  // "아직 고르기를 시작하지 않았다"(`idle`)를 여기서 따로 들고 키를 먼저 받는다.
  let idle = true;
  let shownFor: string | null = null;
  const isPlain = (state: EditorState) =>
    completionStatus(state) === "active" && currentCompletions(state)[0]?.type === PLAIN_TYPE;
  const paintIdle = (view: EditorView) => {
    // 고른 줄 표시를 지운다/되살린다 (styles.css의 `.cm-plain-idle`)
    const on = idle && isPlain(view.state);
    view.dom.querySelector(".cm-tooltip-autocomplete")?.classList.toggle("cm-plain-idle", on);
  };

  const plainIdle = EditorView.updateListener.of((update) => {
    const state = update.state;
    if (!isPlain(state)) {
      shownFor = null;
      return;
    }
    // 친 글자가 달라졌으면(목록이 새로 잡혔으면) 고르기를 처음으로 돌린다
    const spot = plainSpot(state, state.selection.main.head);
    const key = spot ? `${spot.from}:${spot.typed}` : null;
    if (key !== shownFor) {
      shownFor = key;
      idle = true;
    }
    // 목록 DOM은 이 갱신이 끝난 뒤에 그려진다
    requestAnimationFrame(() => paintIdle(update.view));
  });

  const plainKeys = Prec.highest(
    EditorView.domEventHandlers({
      keydown(event, view) {
        if (!isPlain(view.state)) return false;
        const key = suggestKey(event);
        if (idle) {
          if (key === "ArrowDown" || key === "Tab") {
            // 여기서부터 고르기 — 첫 줄을 고른다
            idle = false;
            view.dispatch({ effects: setSelectedCompletion(0) });
            paintIdle(view);
            event.preventDefault();
            return true;
          }
          if (key === "Enter" || key === "ArrowUp") {
            // 목록을 물리고 키는 제 일을 하게 둔다 (줄바꿈 · 윗줄로)
            closeCompletion(view);
            return false;
          }
          return false;
        }
        if (key === "Tab") {
          event.preventDefault();
          return acceptCompletion(view);
        }
        return false;
      },
    }),
  );

  return [
    autocompletion({ override: [source, plainSource] }),
    plainKeys,
    plainIdle,
    composingArrows,
  ];
}

/** `[[` 없이 뜬 추천의 표시 (Completion.type) */
const PLAIN_TYPE = "plain-link";
/** 그 추천은 짧게 — 청하지 않은 목록이 화면을 덮으면 안 된다 */
const PLAIN_MAX = 6;
/** 이 구문 안에서는 추천하지 않는다 — 코드·주소·이미 링크·제목 */
const PLAIN_BLOCKED = /^(FencedCode|CodeBlock|CodeText|InlineCode|URL|Autolink|Link|Image|WikiLink|HTMLBlock|HTMLTag|ATXHeading\d|SetextHeading\d)$/;

/** 한글을 조합 중일 때 눌린 ↑↓도 자동완성 목록을 움직이게 한다.
 *
 *  조합 중의 키는 `Process`(229)로 가려져 와서 CodeMirror의 키맵에 걸리지 않는다.
 *  `[[이`까지 치고 곧바로 ↓를 누르면 첫 번째가 헛돌았다 (까닭은 `suggestKey`). */
const composingArrows = Prec.highest(
  EditorView.domEventHandlers({
    keydown(event, view) {
      // 평소의 화살표는 CodeMirror 키맵이 이미 처리한다 — 가려진 것만 여기서 받는다
      if (event.key === "ArrowDown" || event.key === "ArrowUp") return false;
      const key = suggestKey(event);
      if (key !== "ArrowDown" && key !== "ArrowUp") return false;
      if (completionStatus(view.state) !== "active") return false;
      event.preventDefault();
      return moveCompletionSelection(key === "ArrowDown")(view);
    },
  }),
);
