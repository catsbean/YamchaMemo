import { useState } from "react";
import { redo, undo } from "@codemirror/commands";
import type { Command, EditorView } from "@codemirror/view";
import type { CalloutKind } from "../lib/callouts";
import { useContextMenu, type MenuItem } from "../lib/contextMenu";
import { calloutAtCursor, unwrapCallout, wrapAsCallout } from "../editor/editorMenu";
import {
  insertLink,
  insertWikiLink,
  orderedList,
  toggleLinePrefix,
  toggleWrap,
} from "../editor/format";
import ContextMenu from "./ContextMenu";

/** 원문 편집 위에 놓이는 서식 툴바.
 *
 *  명령은 우클릭 메뉴와 같은 함수(`editor/format`, `editor/editorMenu`)를 부른다 —
 *  진실은 한 곳에만 두고 툴바는 껍데기다.
 *  버튼 툴팁에 단축키를 적어 두었다. 툴바를 쓰다 단축키로 넘어가는 게 목표다. */
export default function EditorToolbar({
  view,
  calloutKinds = [],
}: {
  /** 에디터가 아직 안 만들어졌으면 null (버튼은 눌러도 아무 일 없다) */
  view: EditorView | null;
  calloutKinds?: CalloutKind[];
}) {
  const menu = useContextMenu();
  // 콜아웃 안인지 등은 커서가 움직일 때마다 달라진다 — 메뉴를 열 때 그 자리에서 본다
  const [, force] = useState(0);

  const run = (cmd: Command) => () => {
    if (!view) return;
    cmd(view);
    view.focus();
    force((n) => n + 1);
  };

  /** 버튼 아래에 앱의 우클릭 메뉴를 그대로 띄운다 */
  const openUnder = (e: React.MouseEvent<HTMLButtonElement>, items: MenuItem[]) => {
    const r = e.currentTarget.getBoundingClientRect();
    menu.open(
      { clientX: r.left, clientY: r.bottom + 2, preventDefault: () => {} },
      items,
    );
  };

  const headingItems: MenuItem[] = [
    { label: "제목 1 (가장 큼)", onClick: run(toggleLinePrefix("# ")) },
    { label: "제목 2", onClick: run(toggleLinePrefix("## ")) },
    { label: "제목 3", onClick: run(toggleLinePrefix("### ")) },
    { separator: true },
    {
      label: "본문으로 되돌리기",
      hint: "같은 제목을 한 번 더",
      onClick: run(toggleLinePrefix("# ")),
    },
  ];

  const calloutItems: MenuItem[] = [
    ...calloutKinds.map((k) => ({
      label: `${k.icon} ${k.label}으로 감싸기`,
      onClick: () => {
        if (!view) return;
        wrapAsCallout(view, k.label);
        force((n) => n + 1);
      },
    })),
    { separator: true },
    {
      label: "일반 텍스트로 풀기",
      hint: "제목 3 + 본문",
      disabled: !view || !calloutAtCursor(view),
      onClick: () => {
        if (!view) return;
        unwrapCallout(view);
        force((n) => n + 1);
      },
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-neutral-200 bg-neutral-50 px-2 py-1">
      <Menu label="제목" hint="제목 1~3" onOpen={(e) => openUnder(e, headingItems)}>
        <span className="font-bold">H</span>
      </Menu>

      <Divider />
      <Btn hint="굵게 (Ctrl+B)" onClick={run(toggleWrap("**"))}>
        <span className="font-bold">B</span>
      </Btn>
      <Btn hint="기울임 (Ctrl+I)" onClick={run(toggleWrap("*"))}>
        <span className="italic">I</span>
      </Btn>
      <Btn hint="취소선" onClick={run(toggleWrap("~~"))}>
        <span className="line-through">S</span>
      </Btn>
      <Btn hint="코드 (Ctrl+Shift+C)" onClick={run(toggleWrap("`"))}>
        <span className="font-mono text-[11px]">{"</>"}</span>
      </Btn>

      <Divider />
      <Btn hint="글머리 목록" onClick={run(toggleLinePrefix("- "))}>
        •
      </Btn>
      <Btn hint="번호 목록" onClick={run(orderedList)}>
        <span className="text-[11px]">1.</span>
      </Btn>
      <Btn hint="할 일 (체크박스)" onClick={run(toggleLinePrefix("- [ ] "))}>
        ☑
      </Btn>
      <Btn hint="인용" onClick={run(toggleLinePrefix("> "))}>
        ❝
      </Btn>

      {calloutKinds.length > 0 && (
        <>
          <Divider />
          <Menu
            label="기록"
            hint="선택한 곳을 기록 상자로"
            onOpen={(e) => openUnder(e, calloutItems)}
          >
            <span>🕘</span>
          </Menu>
        </>
      )}

      <Divider />
      <Btn hint="노트 연결 (Ctrl+Shift+K)" onClick={run(insertWikiLink)}>
        🔗
      </Btn>
      <Btn hint="링크 넣기 (주소)" onClick={run(insertLink)}>
        🌐
      </Btn>

      <Divider />
      <Btn hint="실행 취소 (Ctrl+Z)" onClick={run(undo)}>
        ↺
      </Btn>
      <Btn hint="다시 실행 (Ctrl+Y)" onClick={run(redo)}>
        ↻
      </Btn>

      {menu.menu && <ContextMenu state={menu.menu} onClose={menu.close} />}
    </div>
  );
}

const BTN =
  "flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-sm text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900";

function Btn({
  hint,
  onClick,
  children,
}: {
  hint: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button className={BTN} title={hint} onClick={onClick}>
      {children}
    </button>
  );
}

function Menu({
  label,
  hint,
  onOpen,
  children,
}: {
  label: string;
  hint: string;
  onOpen: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <button className={BTN} title={`${label} — ${hint}`} onClick={onOpen}>
      {children}
      <span className="ml-0.5 text-[9px] text-neutral-400">▾</span>
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-4 w-px bg-neutral-300" />;
}
