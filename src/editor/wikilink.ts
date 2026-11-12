// [[위키링크]] — 마크다운 인라인 파서 확장 + Ctrl+클릭 이동 + 자동완성

import {
  autocompletion,
  completionStatus,
  moveCompletionSelection,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";
import { matchLinkOptions, suggestKey } from "../lib/linkMatch";
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
    return {
      from,
      filter: false,
      options: matchLinkOptions(getOptions(), query, EDITOR_MAX).map(completionOf),
    };
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
  return [autocompletion({ override: [source] }), composingArrows];
}

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
