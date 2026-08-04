import { useState } from "react";
import type { NoteContent } from "../bindings";
import { wrapDocument } from "../lib/exportHtml";
import { buildNoteDoc } from "../lib/exportNote";
import { printHtml, saveTextAs } from "../lib/exportFile";
import { useContextMenu, type MenuItem } from "../lib/contextMenu";
import ContextMenu from "./ContextMenu";

/** 노트 한 편을 "화면에 보이는 모양"으로 내보낸다.
 *
 *  파일 자체는 이미 마크다운이라 내보낼 게 없다. 필요한 건 남에게 보여 줄
 *  모양이므로, 스타일이 박힌 HTML 한 장으로 만들고 PDF는 인쇄를 거친다. */
export default function ExportNoteButton({ note }: { note: NoteContent }) {
  const menu = useContextMenu();
  const [error, setError] = useState("");

  function document(): { name: string; html: string; text: string } {
    const d = buildNoteDoc(note);
    return {
      name: d.title,
      html: wrapDocument(d.title, d.html, d.meta),
      text: d.text,
    };
  }

  const items: MenuItem[] = [
    {
      label: "🖨️ 인쇄 · PDF로 저장",
      hint: "인쇄 창에서 PDF 선택",
      onClick: () => printHtml(document().html),
    },
    {
      label: "🖼️ HTML로 저장",
      hint: "스타일까지 한 파일",
      onClick: async () => {
        try {
          const d = document();
          await saveTextAs(d.name, "html", "HTML 문서", d.html);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      label: "📄 텍스트로 저장",
      hint: "글자만 — 어디에나 붙여넣기",
      onClick: async () => {
        try {
          const d = document();
          await saveTextAs(d.name, "txt", "텍스트", d.text);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];

  return (
    <>
      <button
        className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          menu.open(
            { clientX: r.left, clientY: r.bottom + 2, preventDefault: () => {} },
            items,
          );
        }}
        title="보기 좋은 모양으로 내보내기 (HTML · 인쇄 · PDF)"
      >
        내보내기
      </button>
      {menu.menu && <ContextMenu state={menu.menu} onClose={menu.close} />}
      {error && (
        <span className="ml-1 text-2xs text-rose-500" title={error}>
          실패
        </span>
      )}
    </>
  );
}
