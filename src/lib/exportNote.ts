import type { NoteContent, ReadingEntry } from "../bindings";
import { splitBookBody } from "./book";
import { bodyToHtml } from "./exportHtml";
import { BOOK_STATUS_LABELS, fmStr } from "./note";

/** 내보낼 문서 한 편 — 화면에 보이는 모양(html)과 글자만 남긴 모양(text). */
export interface NoteDoc {
  title: string;
  meta: string;
  html: string;
  text: string;
}

/** 노트 한 편을 내보낼 문서로. 종류에 따라 제목·부제·본문 구성이 다르다.
 *
 *  버튼과 대화상자 양쪽이 이걸 쓴다 — 같은 노트가 어디서 내보내든 같은 모양이어야 한다. */
export function buildNoteDoc(note: NoteContent): NoteDoc {
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
    const meta = [...bits, ...tags].join(" · ");
    return {
      title,
      meta,
      html:
        (intro.trim() ? `<h2>소개</h2>\n${bodyToHtml(intro)}\n` : "") +
        `<h2>기록</h2>\n${bodyToHtml(records)}`,
      text: [
        title,
        meta,
        "",
        ...(intro.trim() ? ["## 소개", intro.trim(), ""] : []),
        "## 기록",
        records.trim(),
      ].join("\n"),
    };
  }

  const t = note.note_type === "daily" ? `${stem} 일지` : title;
  const meta = [date, ...tags].filter(Boolean).join(" · ");
  return {
    title: t,
    meta,
    html: bodyToHtml(note.body),
    text: [t, meta, "", note.body.trim()].join("\n"),
  };
}

/** 독서기록 목록(지금 화면에 보이는 것)을 내보낼 문서로.
 *
 *  화면과 같은 순서·묶음으로 낸다 — 책별로 묶어야 나중에 읽을 때 맥락이 산다. */
export function buildReadingDoc(entries: ReadingEntry[]): NoteDoc {
  const byBook = new Map<string, ReadingEntry[]>();
  for (const e of entries) {
    byBook.set(e.book_rel, [...(byBook.get(e.book_rel) ?? []), e]);
  }

  const htmlParts: string[] = [];
  const textParts: string[] = [];
  for (const list of byBook.values()) {
    const head = list[0];
    const sub = [head.book_author, head.genre].filter(Boolean).join(" · ");
    htmlParts.push(
      `<h2>${escapeText(head.book_title)}</h2>` +
        (sub ? `<p class="doc-meta">${escapeText(sub)}</p>` : ""),
    );
    textParts.push(`## ${head.book_title}${sub ? ` (${sub})` : ""}`);
    for (const e of list) {
      const label = [e.kind_label, e.date].filter(Boolean).join(" · ");
      htmlParts.push(bodyToHtml(`> [!${e.kind_label}] ${e.date}\n> ${e.text.replace(/\n/g, "\n> ")}`));
      textParts.push(`- [${label}] ${e.text.replace(/\n/g, "\n  ")}`);
    }
    textParts.push("");
  }

  const meta = `${entries.length}개 기록 · 책 ${byBook.size}권`;
  return {
    title: "독서기록",
    meta,
    html: htmlParts.join("\n"),
    text: ["독서기록", meta, "", ...textParts].join("\n"),
  };
}

/** 본문에 섞여도 HTML로 새지 않게 (exportHtml의 것과 같은 규칙) */
function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
