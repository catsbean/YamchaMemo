// Obsidian식 라이브 프리뷰: 커서가 닿지 않은 마크업의 문법 기호를 숨기고
// 서식만 렌더링한다. 커서가 해당 요소 범위에 들어오면 원문이 다시 보인다.

import { RangeSet, type Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  MatchDecorator,
  WidgetType,
} from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useVault } from "../stores/vault";

/** 이미지 경로 해석: http는 그대로, vault 상대 경로는 asset 프로토콜 */
function resolveImageSrc(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const vault = useVault.getState().vaultPath;
  if (!vault) return url;
  return convertFileSrc(`${vault}\\${decodeURI(url).replace(/\//g, "\\")}`);
}

class ImageWidget extends WidgetType {
  constructor(readonly url: string) {
    super();
  }
  eq(other: ImageWidget) {
    return other.url === this.url;
  }
  toDOM() {
    const img = document.createElement("img");
    img.src = resolveImageSrc(this.url);
    img.className = "cm-inline-img";
    img.onerror = () => {
      img.replaceWith(
        Object.assign(document.createElement("span"), {
          textContent: `🖼️ ${this.url}`,
          className: "cm-inline-img-broken",
        }),
      );
    };
    return img;
  }
  ignoreEvent() {
    return false;
  }
}

/** 문법 기호를 숨길 컨테이너 노드 → 숨김 대상 마크 노드 이름 */
const MARK_PARENTS: Record<string, true> = {
  ATXHeading1: true,
  ATXHeading2: true,
  ATXHeading3: true,
  ATXHeading4: true,
  ATXHeading5: true,
  ATXHeading6: true,
  StrongEmphasis: true,
  Emphasis: true,
  InlineCode: true,
  Strikethrough: true,
  WikiLink: true,
};

const MARK_NODES: Record<string, true> = {
  HeaderMark: true,
  EmphasisMark: true,
  CodeMark: true,
  StrikethroughMark: true,
  WikiLinkMark: true,
};

const HEADING_CLASS: Record<string, string> = {
  ATXHeading1: "cm-lp-h1",
  ATXHeading2: "cm-lp-h2",
  ATXHeading3: "cm-lp-h3",
  ATXHeading4: "cm-lp-h4",
  ATXHeading5: "cm-lp-h5",
  ATXHeading6: "cm-lp-h6",
};

function selectionTouches(view: EditorView, from: number, to: number): boolean {
  for (const range of view.state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

/** 콜아웃 종류별 색상 클래스 (독서기록 발췌/생각/요약/질문) */
const CALLOUT_CLASS: Record<string, string> = {
  발췌: "cm-co-excerpt",
  생각: "cm-co-thought",
  요약: "cm-co-summary",
  질문: "cm-co-question",
};

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const tree = syntaxTree(view.state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        // 콜아웃: > [!이름] 으로 시작하는 인용 블록에 색상 스타일
        if (node.name === "Blockquote") {
          const doc = view.state.doc;
          const firstLine = doc.lineAt(node.from);
          const m = firstLine.text.match(/^\s*>\s*\[!([^\]]+)\]/);
          if (m) {
            const cls = CALLOUT_CLASS[m[1].trim()] ?? "cm-co-default";
            for (let pos = node.from; pos <= node.to && pos <= doc.length; ) {
              const line = doc.lineAt(pos);
              const header =
                line.number === firstLine.number ? " cm-callout-header" : "";
              ranges.push(
                Decoration.line({
                  class: `cm-callout ${cls}${header}`,
                }).range(line.from),
              );
              if (line.to + 1 > node.to) break;
              pos = line.to + 1;
            }
          }
        }
        // 이미지: 커서가 밖에 있으면 실제 이미지로 렌더
        if (node.name === "Image") {
          if (!selectionTouches(view, node.from, node.to)) {
            const urlNode = node.node.getChild("URL");
            if (urlNode) {
              const url = view.state.sliceDoc(urlNode.from, urlNode.to);
              ranges.push(
                Decoration.replace({
                  widget: new ImageWidget(url),
                }).range(node.from, node.to),
              );
              return false; // 내부 마크 처리 생략
            }
          }
        }
        // 체크박스: 클릭 유도 스타일
        if (node.name === "TaskMarker") {
          ranges.push(
            Decoration.mark({ class: "cm-taskbox" }).range(node.from, node.to),
          );
        }
        // 헤딩 줄 스타일 (항상 적용)
        const headingClass = HEADING_CLASS[node.name];
        if (headingClass) {
          const line = view.state.doc.lineAt(node.from);
          ranges.push(
            Decoration.line({ class: headingClass }).range(line.from),
          );
        }
        // 마크 숨김: 부모 요소에 커서가 없을 때만
        if (MARK_NODES[node.name]) {
          const parent = node.node.parent;
          if (!parent || !MARK_PARENTS[parent.name]) return;
          if (selectionTouches(view, parent.from, parent.to)) return;
          let hideTo = node.to;
          // 헤딩 마크는 뒤따르는 공백까지 숨김 ("# " 전체)
          if (
            node.name === "HeaderMark" &&
            view.state.sliceDoc(hideTo, hideTo + 1) === " "
          ) {
            hideTo += 1;
          }
          ranges.push(Decoration.replace({}).range(node.from, hideTo));
        }
      },
    });
  }
  return RangeSet.of(ranges, true);
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** 인라인 #태그 하이라이트 */
const hashtagDecorator = new MatchDecorator({
  regexp: /(^|\s)#([\p{L}\p{N}/_-]+)/gu,
  decorate(add, from, _to, match) {
    const start = from + match[1].length;
    add(
      start,
      start + 1 + match[2].length,
      Decoration.mark({ class: "cm-lp-hashtag" }),
    );
  },
});

const hashtagPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = hashtagDecorator.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = hashtagDecorator.updateDeco(update, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

/** 체크박스 클릭 토글: `- [ ]` ↔ `- [x]` */
const taskToggle = EditorView.domEventHandlers({
  mousedown(event, view) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    const tree = syntaxTree(view.state);
    for (
      let n: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(
        pos,
        0,
      );
      n;
      n = n.parent
    ) {
      if (n.name === "TaskMarker") {
        const cur = view.state.sliceDoc(n.from, n.to);
        const next = /x/i.test(cur) ? "[ ]" : "[x]";
        view.dispatch({ changes: { from: n.from, to: n.to, insert: next } });
        event.preventDefault();
        return true;
      }
    }
    return false;
  },
});

const livePreviewTheme = EditorView.baseTheme({
  ".cm-lp-h1": { fontSize: "1.7em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-lp-h2": { fontSize: "1.45em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-lp-h3": { fontSize: "1.25em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-lp-h4": { fontSize: "1.1em", fontWeight: "700" },
  ".cm-lp-h5": { fontSize: "1em", fontWeight: "700" },
  ".cm-lp-h6": { fontSize: "0.9em", fontWeight: "700", color: "#6b7280" },
  ".cm-lp-hashtag": {
    color: "#7c3aed",
    backgroundColor: "rgba(124, 58, 237, 0.08)",
    borderRadius: "4px",
    padding: "0 2px",
  },
  // 콜아웃 공통
  ".cm-callout": {
    borderLeft: "3px solid #d4d4d4",
    paddingLeft: "8px",
    backgroundColor: "rgba(0,0,0,0.02)",
  },
  ".cm-callout-header": { fontWeight: "600" },
  ".cm-co-excerpt": {
    borderLeftColor: "#f59e0b",
    backgroundColor: "rgba(245, 158, 11, 0.06)",
  },
  ".cm-co-thought": {
    borderLeftColor: "#0ea5e9",
    backgroundColor: "rgba(14, 165, 233, 0.06)",
  },
  ".cm-co-summary": {
    borderLeftColor: "#10b981",
    backgroundColor: "rgba(16, 185, 129, 0.06)",
  },
  ".cm-co-question": {
    borderLeftColor: "#8b5cf6",
    backgroundColor: "rgba(139, 92, 246, 0.06)",
  },
  ".cm-co-default": {
    borderLeftColor: "#a3a3a3",
    backgroundColor: "rgba(0,0,0,0.03)",
  },
  ".cm-inline-img": {
    maxWidth: "100%",
    maxHeight: "320px",
    display: "block",
    borderRadius: "6px",
    margin: "4px 0",
    boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
  },
  ".cm-inline-img-broken": { color: "#9ca3af", fontSize: "0.85em" },
  ".cm-taskbox": { cursor: "pointer", color: "#7c3aed" },
});

export function livePreview() {
  return [livePreviewPlugin, hashtagPlugin, taskToggle, livePreviewTheme];
}
