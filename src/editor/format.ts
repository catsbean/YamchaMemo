// 마크다운 서식 단축키와 리스트 들여쓰기.
// Ctrl+K는 전역 검색(App.tsx)이 쓰므로 여기서 잡지 않는다.

import { EditorSelection, type ChangeSpec } from "@codemirror/state";
import { indentMore, indentLess } from "@codemirror/commands";
import { keymap, type Command, type EditorView } from "@codemirror/view";

/** 선택 범위를 mark로 감싸거나, 이미 감싸져 있으면 벗긴다.
 *  선택이 없으면 mark 한 쌍을 넣고 커서를 가운데로 둔다. */
function toggleWrap(mark: string): Command {
  return (view: EditorView) => {
    const { state } = view;
    const changes: ChangeSpec[] = [];
    const ranges = state.selection.ranges.map((range) => {
      const before = state.sliceDoc(range.from - mark.length, range.from);
      const after = state.sliceDoc(range.to, range.to + mark.length);
      const inner = state.sliceDoc(range.from, range.to);

      // 바깥이 이미 mark로 감싸져 있으면 벗긴다
      if (before === mark && after === mark) {
        changes.push(
          { from: range.from - mark.length, to: range.from, insert: "" },
          { from: range.to, to: range.to + mark.length, insert: "" },
        );
        return EditorSelection.range(range.from - mark.length, range.to - mark.length);
      }
      // 선택 안쪽이 mark로 감싸져 있어도 벗긴다
      if (
        inner.length >= mark.length * 2 &&
        inner.startsWith(mark) &&
        inner.endsWith(mark)
      ) {
        changes.push({
          from: range.from,
          to: range.to,
          insert: inner.slice(mark.length, inner.length - mark.length),
        });
        return EditorSelection.range(range.from, range.to - mark.length * 2);
      }
      changes.push(
        { from: range.from, insert: mark },
        { from: range.to, insert: mark },
      );
      return range.empty
        ? EditorSelection.cursor(range.from + mark.length)
        : EditorSelection.range(range.from + mark.length, range.to + mark.length);
    });

    view.dispatch({
      changes,
      selection: EditorSelection.create(ranges, state.selection.mainIndex),
      scrollIntoView: true,
    });
    return true;
  };
}

/** `[[]]`를 넣고 커서를 가운데로 — 이어서 자동완성이 뜬다 */
const insertWikiLink: Command = (view) => {
  const range = view.state.selection.main;
  const inner = view.state.sliceDoc(range.from, range.to);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: `[[${inner}]]` },
    selection: { anchor: range.from + 2 + inner.length },
    scrollIntoView: true,
  });
  return true;
};

/** 커서가 놓인 줄들이 모두 리스트 항목인가 (`- `, `* `, `1. `, 체크박스 포함) */
function inList(view: EditorView): boolean {
  const { state } = view;
  for (const range of state.selection.ranges) {
    const from = state.doc.lineAt(range.from).number;
    const to = state.doc.lineAt(range.to).number;
    for (let n = from; n <= to; n++) {
      if (!/^\s*([-*+]|\d+\.)\s/.test(state.doc.line(n).text)) return false;
    }
  }
  return true;
}

/** 리스트 안에서만 Tab을 들여쓰기로 쓴다.
 *  그 밖에서는 false를 돌려줘 브라우저 기본 동작(포커스 이동)을 남긴다. */
const listIndent: Command = (view) => (inList(view) ? indentMore(view) : false);
const listOutdent: Command = (view) => (inList(view) ? indentLess(view) : false);

export function formatKeymap() {
  return keymap.of([
    { key: "Mod-b", run: toggleWrap("**"), preventDefault: true },
    { key: "Mod-i", run: toggleWrap("*"), preventDefault: true },
    { key: "Mod-Shift-c", run: toggleWrap("`"), preventDefault: true },
    { key: "Mod-Shift-k", run: insertWikiLink, preventDefault: true },
    { key: "Tab", run: listIndent },
    { key: "Shift-Tab", run: listOutdent },
  ]);
}
