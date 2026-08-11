// 에디터 우클릭 메뉴 — 마크다운 문법을 몰라도 서식을 넣을 수 있게 한다.
// 라벨은 문법 이름(##, **) 대신 "제목 1", "굵게"처럼 결과로 부른다.

import { redo, undo } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import type { MenuItem } from "../lib/contextMenu";
import type { CalloutKind } from "../lib/callouts";
import { josaRo } from "../lib/note";
import { wikiLinkTargetAt } from "./wikilink";
import {
  clearFormatting,
  insertLink,
  insertWikiLink,
  orderedList,
  toggleLinePrefix,
  toggleWrap,
} from "./format";

/** 메뉴 한 줄에 들어가도록 긴 제목을 줄인다 */
function ellipsis(s: string, max = 18): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 선택한 줄들을 `> [!종류] 시각` 콜아웃으로 감싼다 (이미 인용이면 접두어를 겹치지 않는다).
 *  첫 줄이 제목(`### 기록 14:32`)이면 제목을 헤더 자리로 올려 되돌리기(일반 텍스트 → 콜아웃)가 깔끔하다. */
export function wrapAsCallout(view: EditorView, label: string) {
  const sel = view.state.selection.main;
  const doc = view.state.doc;
  const from = doc.lineAt(sel.from).from;
  const to = doc.lineAt(sel.to).to;
  const lines = view.state.sliceDoc(from, to).split("\n");

  let meta = new Date().toTimeString().slice(0, 5);
  const head = lines[0]?.match(/^\s*#{1,6}\s+(.*)$/);
  if (head) {
    // `### 기록 14:32` → 종류 이름이 앞에 있으면 떼고 나머지를 날짜·시각 자리로
    const rest = head[1].trim();
    meta = rest.startsWith(label) ? rest.slice(label.length).trim() : rest;
    lines.shift();
  }

  const body = lines
    .map((l) => {
      const t = l.trim();
      if (!t) return ">";
      return t.startsWith(">") ? t : `> ${t}`;
    })
    .join("\n")
    .replace(/^(>\n)+/, ""); // 제목 아래 빈 줄이 인용 빈 줄로 남지 않게
  const header = `> [!${label}]${meta ? ` ${meta}` : ""}`;
  const insert = body.trim() ? `${header}\n${body}` : `${header}\n> `;

  view.dispatch({ changes: { from, to, insert } });
  view.focus();
}

/** 커서가 닿은 콜아웃의 범위와 헤더 정보. 콜아웃 안이 아니면 null. */
export function calloutAtCursor(view: EditorView) {
  const doc = view.state.doc;
  const start = doc.lineAt(view.state.selection.main.from).number;

  // 위로 올라가며 헤더(`> [!이름]`)를 찾는다. 인용이 끊기면 콜아웃 밖이다.
  let headerLine = 0;
  for (let i = start; i >= 1; i--) {
    const t = doc.line(i).text;
    if (/^\s*>\s*\[!/.test(t)) {
      headerLine = i;
      break;
    }
    if (!/^\s*>/.test(t)) break;
  }
  if (!headerLine) return null;

  const m = doc.line(headerLine).text.match(/^\s*>\s*\[!([^\]]+)\]\s*(.*)$/);
  if (!m) return null;

  let lastLine = headerLine;
  for (let i = headerLine + 1; i <= doc.lines; i++) {
    if (!/^\s*>/.test(doc.line(i).text)) break;
    lastLine = i;
  }
  return { headerLine, lastLine, label: m[1].trim(), meta: m[2].trim() };
}

/** 콜아웃을 `### 종류 시각` 제목 + 일반 텍스트로 푼다 */
export function unwrapCallout(view: EditorView) {
  const found = calloutAtCursor(view);
  if (!found) return;
  const doc = view.state.doc;
  const { headerLine, lastLine, label, meta } = found;

  const body: string[] = [];
  for (let i = headerLine + 1; i <= lastLine; i++) {
    body.push(doc.line(i).text.replace(/^\s*>\s?/, ""));
  }
  const heading = `### ${label}${meta ? ` ${meta}` : ""}`;
  const text = body.join("\n").trim();
  const insert = text ? `${heading}\n\n${text}` : heading;

  view.dispatch({
    changes: { from: doc.line(headerLine).from, to: doc.line(lastLine).to, insert },
  });
  view.focus();
}

/** 스크랩 대상 — 누른 자리의 http(s) 주소와, 저장 후 그 자리를 갈아끼울 수 있게
 *  범위(from~to)도 함께 잡는다. `[글자](url)` 링크 전체(글자까지)든, 맨 URL이든. */
export interface UrlHit {
  url: string;
  from: number;
  to: number;
}

/** (7단계-3, 스크랩하기 트리거 — 사용자가 "링크와 맨 URL 둘 다"를 골랐다) */
function urlAt(view: EditorView, pos: number): UrlHit | null {
  const tree = syntaxTree(view.state);
  let node = tree.resolveInner(pos, 0);
  while (node.parent && node.name !== "Link") node = node.parent;
  if (node.name === "Link") {
    const urlNode = node.node.getChild("URL");
    if (urlNode) {
      const url = view.state.sliceDoc(urlNode.from, urlNode.to);
      // 저장 후 [[제목]]으로 바꿔치기할 범위는 링크 전체(`[글자](url)`)다
      if (/^https?:\/\//i.test(url)) return { url, from: node.from, to: node.to };
    }
  }
  // 링크 문법이 아니면 그 줄 안에서 클릭 지점을 포함하는 맨 URL을 찾는다
  const line = view.state.doc.lineAt(pos);
  const re = /https?:\/\/\S+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line.text))) {
    const from = line.from + m.index;
    const to = from + m[0].length;
    if (pos >= from && pos <= to) return { url: m[0], from, to };
  }
  return null;
}

/** 에디터 우클릭 메뉴 구성. `view`는 CodeMirror 인스턴스.
 *  `calloutKinds`를 주면 선택 영역을 그 종류의 콜아웃으로 감싸는 항목이 붙는다.
 *  `link`를 주면 오른쪽 클릭한 자리가 위키링크일 때 [링크로 이동]이,
 *  http(s) 주소일 때 [스크랩하기]가 맨 위에 붙는다
 *  (Ctrl+클릭을 모르거나 키보드를 쓰기 어려운 경우를 위해). */
export function editorMenuItems(
  view: EditorView,
  calloutKinds: CalloutKind[] = [],
  link?: {
    event: { clientX: number; clientY: number };
    onNavigate: (target: string) => void;
    onScrap?: (hit: UrlHit) => void;
  },
): MenuItem[] {
  const sel = view.state.selection.main;
  const hasSelection = !sel.empty;
  const selectedText = view.state.sliceDoc(sel.from, sel.to);

  const run = (cmd: (v: EditorView) => boolean) => () => {
    cmd(view);
    view.focus();
  };

  // 누른 자리가 위키링크인가 / URL인가 (선택 위치가 아니라 마우스 좌표로 판단한다)
  let linkTarget: string | null = null;
  let scrapHit: UrlHit | null = null;
  if (link) {
    const pos = view.posAtCoords({
      x: link.event.clientX,
      y: link.event.clientY,
    });
    if (pos != null) {
      linkTarget = wikiLinkTargetAt(view, pos);
      if (!linkTarget && link.onScrap) scrapHit = urlAt(view, pos);
    }
  }

  return [
    ...(linkTarget
      ? ([
          {
            // 조사는 **자르기 전** 이름으로 고른다 — 잘린 끝의 '…'로는 받침을 알 수 없다
            label: `🔗 ${ellipsis(linkTarget)}${josaRo(linkTarget)} 이동`,
            hint: "Ctrl+클릭",
            onClick: () => link!.onNavigate(linkTarget!),
          },
          { separator: true },
        ] as MenuItem[])
      : []),
    ...(scrapHit
      ? ([
          {
            label: `📎 스크랩하기 — ${ellipsis(scrapHit.url, 28)}`,
            onClick: () => link!.onScrap!(scrapHit!),
          },
          { separator: true },
        ] as MenuItem[])
      : []),
    {
      label: "잘라내기",
      hint: "Ctrl+X",
      disabled: !hasSelection,
      onClick: async () => {
        await navigator.clipboard.writeText(selectedText);
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: "" },
        });
        view.focus();
      },
    },
    {
      label: "복사",
      hint: "Ctrl+C",
      disabled: !hasSelection,
      onClick: async () => {
        await navigator.clipboard.writeText(selectedText);
        view.focus();
      },
    },
    {
      label: "붙여넣기",
      hint: "Ctrl+V",
      onClick: async () => {
        const text = await navigator.clipboard.readText();
        if (!text) return;
        const r = view.state.selection.main;
        view.dispatch({
          changes: { from: r.from, to: r.to, insert: text },
          selection: { anchor: r.from + text.length },
        });
        view.focus();
      },
    },
    { separator: true },

    { label: "굵게", hint: "Ctrl+B", onClick: run(toggleWrap("**")) },
    { label: "기울임", hint: "Ctrl+I", onClick: run(toggleWrap("*")) },
    { label: "취소선", onClick: run(toggleWrap("~~")) },
    { label: "코드", hint: "Ctrl+Shift+C", onClick: run(toggleWrap("`")) },
    { separator: true },

    { label: "제목 1 (가장 큼)", onClick: run(toggleLinePrefix("# ")) },
    { label: "제목 2", onClick: run(toggleLinePrefix("## ")) },
    { label: "제목 3", onClick: run(toggleLinePrefix("### ")) },
    { separator: true },

    { label: "글머리 목록", onClick: run(toggleLinePrefix("- ")) },
    { label: "번호 목록", onClick: run(orderedList) },
    { label: "할 일 (체크박스)", onClick: run(toggleLinePrefix("- [ ] ")) },
    { label: "인용", onClick: run(toggleLinePrefix("> ")) },
    { separator: true },

    { label: "링크 넣기", onClick: run(insertLink) },
    {
      label: "노트 연결",
      hint: "Ctrl+Shift+K",
      onClick: run(insertWikiLink),
    },
    { separator: true },

    { label: "서식 지우기", onClick: run(clearFormatting) },
    { label: "실행 취소", hint: "Ctrl+Z", onClick: run(undo) },
    { label: "다시 실행", hint: "Ctrl+Y", onClick: run(redo) },

    // 기록 콜아웃 ↔ 일반 텍스트 상호 변환
    ...(calloutKinds.length > 0
      ? [
          { separator: true } as MenuItem,
          ...calloutKinds.map((k) => ({
            label: `${k.icon} ${k.label}으로 감싸기`,
            disabled: !hasSelection,
            onClick: () => wrapAsCallout(view, k.label),
          })),
          {
            label: "일반 텍스트로 풀기",
            hint: "제목 3 + 본문",
            disabled: !calloutAtCursor(view),
            onClick: () => unwrapCallout(view),
          } as MenuItem,
        ]
      : []),
  ];
}
