import { useState } from "react";
import type { NoteContent } from "../bindings";
import { splitBookBody } from "../lib/book";
import { bodyToHtml, wrapDocument } from "../lib/exportHtml";
import { printHtml, saveTextAs } from "../lib/exportFile";
import { fmStr, BOOK_STATUS_LABELS } from "../lib/note";
import { useContextMenu, type MenuItem } from "../lib/contextMenu";
import ContextMenu from "./ContextMenu";

/** 노트 한 편을 "화면에 보이는 모양"으로 내보낸다.
 *
 *  파일 자체는 이미 마크다운이라 내보낼 게 없다. 필요한 건 남에게 보여 줄
 *  모양이므로, 스타일이 박힌 HTML 한 장으로 만들고 PDF는 인쇄를 거친다. */
export default function ExportNoteButton({ note }: { note: NoteContent }) {
  const menu = useContextMenu();
  const [error, setError] = useState("");

  /** 노트 종류에 맞는 제목·부제·본문을 만든다 */
  function build(): { title: string; meta: string; html: string } {
    const fm = note.frontmatter as Record<string, unknown> | null;
    const stem = note.rel_path.split("/").pop()?.replace(/\.md$/, "") ?? "";
    const title = fmStr(fm, "title") || stem;
    const date = fmStr(fm, "date");
    const tags = ((fm?.tags as string[] | undefined) ?? []).map((t) => `#${t}`);

    if (note.note_type === "book") {
      const { intro, records } = splitBookBody(note.body);
      const bits = [
        fmStr(fm, "author"),
        fmStr(fm, "genre"),
        BOOK_STATUS_LABELS[fmStr(fm, "status")],
        fmStr(fm, "rating") ? `★ ${fmStr(fm, "rating")}` : "",
        fmStr(fm, "finished") ? `완독 ${fmStr(fm, "finished")}` : "",
      ].filter(Boolean);
      const html =
        (intro.trim() ? `<h2>소개</h2>\n${bodyToHtml(intro)}\n` : "") +
        `<h2>기록</h2>\n${bodyToHtml(records)}`;
      return { title, meta: [...bits, ...tags].join(" · "), html };
    }

    return {
      title: note.note_type === "daily" ? `${stem} 일지` : title,
      meta: [date, ...tags].filter(Boolean).join(" · "),
      html: bodyToHtml(note.body),
    };
  }

  function document(): { name: string; html: string } {
    const { title, meta, html } = build();
    return { name: title, html: wrapDocument(title, html, meta) };
  }

  const items: MenuItem[] = [
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
      label: "🖨️ 인쇄 · PDF로 저장",
      hint: "인쇄 창에서 PDF 선택",
      onClick: () => printHtml(document().html),
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
