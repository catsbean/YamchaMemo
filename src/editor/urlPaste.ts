// URL만 붙여넣으면 그대로 넣어 둔 뒤 제목을 받아 [제목](URL)로 바꾼다.
//
// 흐름 — "먼저 넣고, 되면 바꾼다": 네트워크를 기다리며 타이핑을 막지 않는다.
// 1) 붙여넣은 URL을 그대로 문서에 넣는다
// 2) 그 구간을 StateField로 추적한다 (문서가 편집돼도 좌표가 따라온다)
// 3) 구간 끝에 위젯으로 "가져오는 중"을 보여준다 — 문서 텍스트는 건드리지 않는다
// 4) 응답이 오면 그 구간이 여전히 같은 URL일 때만 [제목](URL)로 바꾼다.
//    실패하거나 그 사이 사용자가 고쳤으면 조용히 손을 뗀다.

import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { commands } from "../bindings";

/** 붙여넣는 텍스트 전체가 URL 하나뿐일 때만 반응한다 (문장 속 URL은 그냥 붙여넣는다) */
const URL_ONLY = /^https?:\/\/\S+$/;

interface Pending {
  id: number;
  from: number;
  to: number;
  url: string;
}

let nextId = 0;

const addPending = StateEffect.define<Pending>();
const removePending = StateEffect.define<number>();

const urlPasteTheme = EditorView.baseTheme({
  ".cm-url-fetching": {
    color: "var(--color-neutral-400)",
    fontSize: "0.85em",
  },
});

class LoadingWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.textContent = " ⏳ 가져오는 중…";
    span.className = "cm-url-fetching";
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** 추적 중인 붙여넣기 자리들. 문서가 바뀌면 좌표를 옮기고, 그 자리 텍스트가
 *  더는 원본 URL과 같지 않으면(사용자가 지우거나 고침) 조용히 추적을 그만둔다. */
const pendingField = StateField.define<Pending[]>({
  create: () => [],
  update(value, tr) {
    let next = value.map((p) => ({
      ...p,
      from: tr.changes.mapPos(p.from, 1),
      to: tr.changes.mapPos(p.to, -1),
    }));
    for (const e of tr.effects) {
      if (e.is(addPending)) next = [...next, e.value];
      else if (e.is(removePending)) next = next.filter((p) => p.id !== e.value);
    }
    return next.filter((p) => {
      if (p.to <= p.from || p.to > tr.state.doc.length) return false;
      return tr.state.sliceDoc(p.from, p.to) === p.url;
    });
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) =>
      Decoration.set(
        [...value]
          .sort((a, b) => a.to - b.to)
          .map((p) => Decoration.widget({ widget: new LoadingWidget(), side: 1 }).range(p.to)),
      ),
    ),
});

/** 편집기에 URL만 붙여넣으면 제목을 가져와 마크다운 링크로 바꾸는 확장 */
export function urlPaste(): Extension {
  return [
    pendingField,
    urlPasteTheme,
    EditorView.domEventHandlers({
      paste(event, view) {
        const text = event.clipboardData?.getData("text/plain")?.trim();
        if (!text || !URL_ONLY.test(text)) return false;

        event.preventDefault();
        const from = view.state.selection.main.from;
        view.dispatch(view.state.replaceSelection(text));
        const to = from + text.length;
        const id = nextId++;
        view.dispatch({ effects: addPending.of({ id, from, to, url: text }) });

        commands.fetchPageTitle(text).then((title) => {
          // 노트를 닫는 등으로 뷰가 이미 사라졌을 수 있다
          if ((view as unknown as { destroyed?: boolean }).destroyed) return;
          const p = view.state.field(pendingField).find((x) => x.id === id);
          view.dispatch({ effects: removePending.of(id) });
          // p가 없다 = 그 사이 사용자가 지우거나 고쳤다. title이 없다 = 실패.
          // 둘 다 손대지 않는다 — 원본 URL이 그대로 남는다.
          if (!p || !title) return;
          view.dispatch({
            changes: { from: p.from, to: p.to, insert: `[${title}](${p.url})` },
          });
        });
        return true;
      },
    }),
  ];
}
