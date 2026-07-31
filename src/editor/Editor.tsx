import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  markdown,
  markdownKeymap,
  markdownLanguage,
} from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from "@codemirror/search";
import { commands } from "../bindings";
import { formatKeymap } from "./format";
import { livePreview } from "./livePreview";
import { urlPaste } from "./urlPaste";
import {
  wikiLinkClick,
  wikiLinkCompletion,
  wikiLinkMarkdown,
} from "./wikilink";

/** Ctrl+F 검색 패널 문구 한국어화 */
const SEARCH_PHRASES: Record<string, string> = {
  Find: "찾기",
  Replace: "바꾸기",
  next: "다음",
  previous: "이전",
  all: "전체",
  "match case": "대소문자 구분",
  regexp: "정규식",
  "by word": "단어 단위",
  replace: "바꾸기",
  "replace all": "모두 바꾸기",
  close: "닫기",
  "current match": "현재 일치",
  "replaced $ matches": "$개를 바꿨습니다",
  "replaced match on line $": "$줄의 일치를 바꿨습니다",
  "on line": "줄",
};

interface Props {
  value: string;
  onChange: (value: string) => void;
  onNavigate?: (target: string) => void;
  getTitles?: () => string[];
  /** 목차 등에서 특정 줄로 이동시키기 위한 훅 (1-based) */
  onReady?: (goToLine: (line: number) => void) => void;
  /** 우클릭 — 서식 메뉴를 띄우기 위해 뷰와 위치를 넘긴다 */
  onContextMenu?: (e: MouseEvent, view: EditorView) => void;
  /** 만들어진 뷰를 밖으로 넘긴다 (서식 툴바가 명령을 실행할 때 쓴다) */
  onView?: (view: EditorView) => void;
  /** 읽기 전용 — 타이핑은 막고 체크박스 토글 같은 프로그램적 변경은 그대로 둔다 */
  readOnly?: boolean;
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 클립보드 이미지 붙여넣기 → _attachments 저장 → 마크다운 삽입 */
const pasteImage = EditorView.domEventHandlers({
  paste(event, view) {
    const items = event.clipboardData?.items;
    if (!items) return false;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        event.preventDefault();
        const file = item.getAsFile();
        if (!file) return false;
        const ext = (item.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
        file.arrayBuffer().then(async (buf) => {
          const r = await commands.savePastedImage(bufferToBase64(buf), ext);
          if (r.status === "ok") {
            view.dispatch(view.state.replaceSelection(`![](${r.data})`));
          }
        });
        return true;
      }
    }
    return false;
  },
});

/** 라이브 프리뷰 마크다운 에디터 (커서 위치의 문법만 노출) */
export default function Editor({
  value,
  onChange,
  onNavigate,
  getTitles,
  onReady,
  onContextMenu,
  onView,
  readOnly = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 읽기/편집 전환은 에디터를 다시 만들지 않고 이 칸만 갈아끼운다
  const editableRef = useRef(new Compartment());
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const getTitlesRef = useRef(getTitles);
  getTitlesRef.current = getTitles;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  const onContextMenuRef = useRef(onContextMenu);
  onContextMenuRef.current = onContextMenu;

  useEffect(() => {
    if (!containerRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        editableRef.current.of(EditorView.editable.of(!readOnlyRef.current)),
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        EditorState.phrases.of(SEARCH_PHRASES),
        search({ top: true }),
        highlightSelectionMatches(),
        // 서식·리스트 키맵은 기본 키맵보다 앞에 와야 Tab/Ctrl+B를 먼저 잡는다
        formatKeymap(),
        // markdownKeymap: Enter로 리스트/인용 마커 이어쓰기, Backspace로 마커 지우기
        keymap.of([
          ...searchKeymap,
          ...markdownKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        markdown({ base: markdownLanguage, extensions: [wikiLinkMarkdown] }),
        syntaxHighlighting(defaultHighlightStyle),
        livePreview(),
        pasteImage,
        urlPaste(),
        EditorView.domEventHandlers({
          contextmenu(event, view) {
            if (!onContextMenuRef.current) return false;
            onContextMenuRef.current(event, view);
            return true;
          },
        }),
        wikiLinkClick((target) => onNavigateRef.current?.(target)),
        wikiLinkCompletion(() => getTitlesRef.current?.() ?? []),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "14px" },
          ".cm-content": {
            fontFamily: "'Pretendard', 'Malgun Gothic', sans-serif",
            maxWidth: "48rem",
            padding: "1rem",
          },
          "&.cm-focused": { outline: "none" },
        }),
      ],
    });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    onViewRef.current?.(view);
    onReadyRef.current?.((line: number) => {
      const l = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
      view.dispatch({
        selection: { anchor: l.from },
        effects: EditorView.scrollIntoView(l.from, { y: "start" }),
      });
      view.focus();
    });
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 노트 전환 시(컴포넌트 key 변경) 재생성하므로 value는 초기값으로만 사용
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 읽기/편집 전환
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableRef.current.reconfigure(
        EditorView.editable.of(!readOnly),
      ),
    });
  }, [readOnly]);

  // 외부에서 value가 바뀐 경우(엔트리 append 등) 동기화
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const docText = view.state.doc.toString();
    if (docText !== value) {
      view.dispatch({
        changes: { from: 0, to: docText.length, insert: value },
      });
    }
  }, [value]);

  return <div ref={containerRef} className="h-full overflow-auto" />;
}
