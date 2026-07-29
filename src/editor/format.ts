// 마크다운 서식 단축키와 리스트 들여쓰기.
// Ctrl+K는 전역 검색(App.tsx)이 쓰므로 여기서 잡지 않는다.

import { EditorSelection, type ChangeSpec } from "@codemirror/state";
import { indentMore, indentLess } from "@codemirror/commands";
import { keymap, type Command, type EditorView } from "@codemirror/view";

/** 선택 범위를 mark로 감싸거나, 이미 감싸져 있으면 벗긴다.
 *  선택이 없으면 mark 한 쌍을 넣고 커서를 가운데로 둔다. */
export function toggleWrap(mark: string): Command {
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
export const insertWikiLink: Command = (view) => {
  const range = view.state.selection.main;
  const inner = view.state.sliceDoc(range.from, range.to);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: `[[${inner}]]` },
    selection: { anchor: range.from + 2 + inner.length },
    scrollIntoView: true,
  });
  return true;
};

/** 줄 앞머리 기호를 토글한다. 이미 같은 기호가 있으면 떼고, 다른 기호면 갈아끼운다.
 *  `#`처럼 개수로 단계를 나타내는 기호도 이 한 함수로 처리한다. */
export function toggleLinePrefix(prefix: string): Command {
  return (view: EditorView) => {
    const { state } = view;
    // 기존 앞머리 기호(제목·목록·인용·체크박스)를 통째로 인식한다
    const anyPrefix = /^(\s*)(#{1,6}\s|[-*+]\s\[[ xX]\]\s|[-*+]\s|\d+\.\s|>\s)?/;
    const changes: ChangeSpec[] = [];
    const seen = new Set<number>();

    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(range.to).number;
      for (let n = first; n <= last; n++) {
        if (seen.has(n)) continue;
        seen.add(n);
        const line = state.doc.line(n);
        const m = line.text.match(anyPrefix);
        const indent = m?.[1] ?? "";
        const cur = m?.[2] ?? "";
        // 같은 기호면 해제, 아니면 교체
        const next = cur === prefix ? "" : prefix;
        changes.push({
          from: line.from,
          to: line.from + indent.length + cur.length,
          insert: indent + next,
        });
      }
    }
    if (changes.length === 0) return false;
    view.dispatch({ changes, scrollIntoView: true });
    return true;
  };
}

/** 번호 목록 — 선택한 줄에 1., 2., … 를 매긴다 */
export const orderedList: Command = (view) => {
  const { state } = view;
  const anyPrefix = /^(\s*)(#{1,6}\s|[-*+]\s\[[ xX]\]\s|[-*+]\s|\d+\.\s|>\s)?/;
  const changes: ChangeSpec[] = [];
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from).number;
  const last = state.doc.lineAt(range.to).number;
  // 이미 전부 번호 목록이면 해제
  let allNumbered = true;
  for (let n = first; n <= last; n++) {
    if (!/^\s*\d+\.\s/.test(state.doc.line(n).text)) allNumbered = false;
  }
  let i = 1;
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    const m = line.text.match(anyPrefix);
    const indent = m?.[1] ?? "";
    const cur = m?.[2] ?? "";
    const next = allNumbered ? "" : `${i++}. `;
    changes.push({
      from: line.from,
      to: line.from + indent.length + cur.length,
      insert: indent + next,
    });
  }
  view.dispatch({ changes, scrollIntoView: true });
  return true;
};

/** 일반 링크 `[표시글](주소)` — 선택한 글이 표시글이 되고 커서는 주소 자리로 */
export const insertLink: Command = (view) => {
  const range = view.state.selection.main;
  const text = view.state.sliceDoc(range.from, range.to);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: `[${text}]()` },
    selection: { anchor: range.from + text.length + 3 },
    scrollIntoView: true,
  });
  return true;
};

/** 서식을 모두 걷어낸다 (줄 앞머리 기호 + 굵게/기울임/코드 표시) */
export const clearFormatting: Command = (view) => {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from).number;
  const last = state.doc.lineAt(range.to).number;
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    const plain = line.text
      .replace(/^(\s*)(#{1,6}\s|[-*+]\s\[[ xX]\]\s|[-*+]\s|\d+\.\s|>\s)/, "$1")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1")
      .replace(/`(.+?)`/g, "$1");
    if (plain !== line.text) {
      changes.push({ from: line.from, to: line.to, insert: plain });
    }
  }
  if (changes.length === 0) return false;
  view.dispatch({ changes, scrollIntoView: true });
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
