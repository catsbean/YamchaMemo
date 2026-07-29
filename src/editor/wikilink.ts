// [[위키링크]] — 마크다운 인라인 파서 확장 + Ctrl+클릭 이동 + 자동완성

import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";

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

/** `[[` 입력 시 노트 제목 자동완성 */
export function wikiLinkCompletion(getTitles: () => string[]) {
  function source(context: CompletionContext): CompletionResult | null {
    const match = context.matchBefore(/\[\[([^\]|#\n]*)$/);
    if (!match) return null;
    const from = match.from + 2;
    const titles = getTitles();
    return {
      from,
      options: titles.map((t) => ({
        label: t,
        type: "text",
        apply: `${t}]]`,
      })),
      validFor: /^[^\]|#\n]*$/,
    };
  }
  return autocompletion({ override: [source] });
}
