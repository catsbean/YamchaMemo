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

/** 콜아웃 종류별 색상 클래스 — 입력 바 버튼 색과 같은 계열로 맞춘다.
 *  (독서기록 발췌/생각/요약/질문 · 일지 기록/느낌) */
const CALLOUT_CLASS: Record<string, string> = {
  발췌: "cm-co-excerpt",
  생각: "cm-co-thought",
  요약: "cm-co-summary",
  질문: "cm-co-question",
  기록: "cm-co-log",
  느낌: "cm-co-feeling",
};

/** vault에 등록된 사용자 정의 콜아웃의 색 클래스 (없으면 기본 회색) */
function customCalloutClass(name: string): string {
  const def = useVault.getState().callouts.find((c) => c.label === name);
  return def ? `cm-co-p-${def.color}` : "cm-co-default";
}

/** 커스텀 콜아웃 아이콘 */
function customCalloutIcon(name: string): string | null {
  const def = useVault.getState().callouts.find((c) => c.label === name);
  if (!def) return "💬"; // 앱이 모르는 콜아웃(외부 편집기에서 온 것)
  return def.icon || null; // 등록된 종류인데 아이콘이 '없음'이면 붙이지 않는다
}

/** 콜아웃 종류별 아이콘 — 파일에는 `[!기록]` 텍스트를 그대로 두고 화면에서만 붙인다.
 *  (파일에 이모지를 넣으면 검색·다른 앱 호환이 깨진다) */
const CALLOUT_ICON: Record<string, string> = {
  발췌: "📌",
  생각: "💭",
  요약: "📋",
  질문: "❓",
  기록: "🕘",
  느낌: "💛",
};

/** `[!이름]` 자리에 그려 넣는 아이콘+이름 라벨 */
class CalloutLabelWidget extends WidgetType {
  constructor(readonly name: string) {
    super();
  }
  eq(other: CalloutLabelWidget) {
    return other.name === this.name;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-callout-label";
    const icon = CALLOUT_ICON[this.name] ?? customCalloutIcon(this.name);
    span.textContent = icon ? `${icon} ${this.name}` : this.name;
    return span;
  }
}

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
            const name = m[1].trim();
            const cls = CALLOUT_CLASS[name] ?? customCalloutClass(name);
            // 커서가 콜아웃 안에 있으면 원문(`> [!이름]`)을 그대로 보여 편집할 수 있게 한다
            const raw = selectionTouches(view, node.from, node.to);
            for (let pos = node.from; pos <= node.to && pos <= doc.length; ) {
              const line = doc.lineAt(pos);
              const isHeader = line.number === firstLine.number;
              ranges.push(
                Decoration.line({
                  class: `cm-callout ${cls}${isHeader ? " cm-callout-header" : ""}`,
                }).range(line.from),
              );
              if (!raw) {
                // 줄머리 `> ` 숨김 — 좌측 색 바가 인용 표시를 대신한다
                const qm = line.text.match(/^\s*>\s?/);
                if (qm && qm[0].length > 0) {
                  ranges.push(
                    Decoration.replace({}).range(
                      line.from,
                      line.from + qm[0].length,
                    ),
                  );
                }
                // 첫 줄의 `[!이름]`을 아이콘+이름 라벨로 치환
                if (isHeader) {
                  const bm = line.text.match(/\[!([^\]]+)\]/);
                  if (bm && bm.index !== undefined) {
                    const labelFrom = line.from + bm.index;
                    ranges.push(
                      Decoration.replace({
                        widget: new CalloutLabelWidget(name),
                      }).range(labelFrom, labelFrom + bm[0].length),
                    );
                  }
                }
              }
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
        // 목록: 기호(-, 1.)를 흐리게 하고 줄에 내어쓰기를 준다.
        // 원문을 바꾸지 않으므로 다른 마크다운 앱에서 열어도 그대로 목록이다.
        if (node.name === "ListMark") {
          ranges.push(
            Decoration.mark({ class: "cm-lp-listmark" }).range(node.from, node.to),
          );
          const line = view.state.doc.lineAt(node.from);
          ranges.push(
            Decoration.line({ class: "cm-lp-listline" }).range(line.from),
          );
        }
        // 위키링크: 색 + 마우스 올렸을 때 음영 (기록 카드의 링크와 같은 계열)
        if (node.name === "WikiLink") {
          ranges.push(
            Decoration.mark({ class: "cm-wikilink" }).range(node.from, node.to),
          );
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
  // 목록 — 기호는 흐리게, 줄바꿈된 글은 글자 아래로 맞춰 목록처럼 읽히게
  ".cm-lp-listmark": { color: "#a3a3a3" },
  ".cm-lp-listline": { textIndent: "-1.3em", paddingLeft: "1.3em" },
  // 위키링크 — 기록 카드의 링크(NoteText)와 같은 보라 계열로 맞춘다.
  // 편집기에서는 그냥 클릭하면 커서가 놓이는 자리라 손가락 커서는 쓰지 않는다
  // (이동은 Ctrl+클릭 또는 우클릭 메뉴).
  ".cm-wikilink": {
    color: "#7c3aed",
    textDecoration: "underline",
    textDecorationColor: "#c4b5fd",
    textUnderlineOffset: "2px",
    borderRadius: "3px",
  },
  ".cm-wikilink:hover": {
    backgroundColor: "rgba(124, 58, 237, 0.10)",
    textDecorationColor: "#8b5cf6",
  },
  // 콜아웃 공통
  ".cm-callout": {
    borderLeft: "3px solid #d4d4d4",
    paddingLeft: "8px",
    backgroundColor: "rgba(0,0,0,0.02)",
  },
  ".cm-callout-header": { fontWeight: "600" },
  // 아이콘+이름 라벨 (원문 `[!이름]` 자리에 그려진다)
  ".cm-callout-label": { fontWeight: "600", marginRight: "2px" },
  ".cm-co-excerpt .cm-callout-label": { color: "#b45309" },
  ".cm-co-thought .cm-callout-label": { color: "#0369a1" },
  ".cm-co-summary .cm-callout-label": { color: "#047857" },
  ".cm-co-question .cm-callout-label": { color: "#6d28d9" },
  ".cm-co-log .cm-callout-label": { color: "#0369a1" },
  ".cm-co-feeling .cm-callout-label": { color: "#b45309" },
  ".cm-co-default .cm-callout-label": { color: "#525252" },
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
  // 일지 — 입력 바의 기록(sky)·느낌(amber) 버튼과 같은 색
  ".cm-co-log": {
    borderLeftColor: "#0ea5e9",
    backgroundColor: "rgba(14, 165, 233, 0.06)",
  },
  ".cm-co-feeling": {
    borderLeftColor: "#f59e0b",
    backgroundColor: "rgba(245, 158, 11, 0.06)",
  },
  // 커스텀 콜아웃용 팔레트
  ".cm-co-p-amber": { borderLeftColor: "#f59e0b", backgroundColor: "rgba(245,158,11,0.06)" },
  ".cm-co-p-orange": { borderLeftColor: "#f97316", backgroundColor: "rgba(249,115,22,0.06)" },
  ".cm-co-p-yellow": { borderLeftColor: "#eab308", backgroundColor: "rgba(234,179,8,0.06)" },
  ".cm-co-p-lime": { borderLeftColor: "#84cc16", backgroundColor: "rgba(132,204,22,0.06)" },
  ".cm-co-p-emerald": { borderLeftColor: "#10b981", backgroundColor: "rgba(16,185,129,0.06)" },
  ".cm-co-p-teal": { borderLeftColor: "#14b8a6", backgroundColor: "rgba(20,184,166,0.06)" },
  ".cm-co-p-sky": { borderLeftColor: "#0ea5e9", backgroundColor: "rgba(14,165,233,0.06)" },
  ".cm-co-p-blue": { borderLeftColor: "#3b82f6", backgroundColor: "rgba(59,130,246,0.06)" },
  ".cm-co-p-indigo": { borderLeftColor: "#6366f1", backgroundColor: "rgba(99,102,241,0.06)" },
  ".cm-co-p-violet": { borderLeftColor: "#8b5cf6", backgroundColor: "rgba(139,92,246,0.06)" },
  ".cm-co-p-fuchsia": { borderLeftColor: "#d946ef", backgroundColor: "rgba(217,70,239,0.06)" },
  ".cm-co-p-rose": { borderLeftColor: "#f43f5e", backgroundColor: "rgba(244,63,94,0.06)" },
  ".cm-co-p-stone": { borderLeftColor: "#a8a29e", backgroundColor: "rgba(168,162,158,0.06)" },
  ".cm-co-p-red": { borderLeftColor: "#ef4444", backgroundColor: "rgba(239,68,68,0.06)" },
  ".cm-co-p-black": { borderLeftColor: "#171717", backgroundColor: "rgba(23,23,23,0.05)" },
  ".cm-co-p-neutral": { borderLeftColor: "#a3a3a3", backgroundColor: "rgba(163,163,163,0.06)" },
  ".cm-co-p-amber .cm-callout-label": { color: "#b45309" },
  ".cm-co-p-orange .cm-callout-label": { color: "#c2410c" },
  ".cm-co-p-yellow .cm-callout-label": { color: "#a16207" },
  ".cm-co-p-lime .cm-callout-label": { color: "#4d7c0f" },
  ".cm-co-p-emerald .cm-callout-label": { color: "#047857" },
  ".cm-co-p-teal .cm-callout-label": { color: "#0f766e" },
  ".cm-co-p-sky .cm-callout-label": { color: "#0369a1" },
  ".cm-co-p-blue .cm-callout-label": { color: "#1d4ed8" },
  ".cm-co-p-indigo .cm-callout-label": { color: "#4338ca" },
  ".cm-co-p-violet .cm-callout-label": { color: "#6d28d9" },
  ".cm-co-p-fuchsia .cm-callout-label": { color: "#a21caf" },
  ".cm-co-p-rose .cm-callout-label": { color: "#be123c" },
  ".cm-co-p-stone .cm-callout-label": { color: "#57534e" },
  ".cm-co-p-red .cm-callout-label": { color: "#b91c1c" },
  ".cm-co-p-black .cm-callout-label": { color: "#171717" },
  ".cm-co-p-neutral .cm-callout-label": { color: "#525252" },
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
  // 체크박스 — 입력 바의 할 일(emerald) 버튼과 같은 색
  ".cm-taskbox": { cursor: "pointer", color: "#10b981" },
});

export function livePreview() {
  return [livePreviewPlugin, hashtagPlugin, taskToggle, livePreviewTheme];
}
