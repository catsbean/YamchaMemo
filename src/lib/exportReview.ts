import type { NoteTodo } from "../bindings";
import { weekdayOf } from "./date";
import { bodyToHtml } from "./exportHtml";
import type { NoteDoc } from "./exportNote";
import { activeChips, type ReviewCard, type ReviewFilter } from "./reviewFilter";

/** 문서로 낼 날짜 한 칸 — 화면이 그리는 것과 같은 모양이어야 한다 */
export interface ReviewSection {
  date: string;
  cards: ReviewCard[];
  todos: NoteTodo[];
}

export interface ReviewInfo {
  /** 기간 표기 (`2026년 8월`) */
  label: string;
  filter: ReviewFilter;
}

/** 콜아웃 머리에 붙일 곁말.
 *
 *  일지 기록은 시각, 독서기록은 날짜와 책 제목. 내보내기 변환기가 `[!종류]` 뒤
 *  나머지를 그대로 곁말로 넣어 주므로 여기서 한 줄로 만들어 넘긴다. */
function metaOf(c: ReviewCard): string {
  return c.source === "book"
    ? [c.date, c.bookTitle].filter(Boolean).join(" · ")
    : c.time;
}

/** 지금 화면에 보이는 회고를 문서 한 편으로.
 *
 *  화면과 순서·묶음이 같아야 한다 — 인쇄물이 화면과 다르면 필터를 건 보람이 없다.
 *  **독서기록도 함께 담는다**: 예전에는 화면에는 보이는데 인쇄하면 빠졌다. */
export function buildReviewDoc(
  sections: ReviewSection[],
  info: ReviewInfo,
): NoteDoc {
  const md: string[] = [];
  const text: string[] = [];

  for (const s of sections) {
    const head = `${s.date} (${weekdayOf(s.date)})`;
    md.push(`## ${head}`);
    text.push(`## ${head}`);

    for (const t of s.todos) {
      md.push(`- [${t.done ? "x" : " "}] ${t.text}`);
      text.push(`- [${t.done ? "x" : " "}] ${t.text}`);
    }
    if (s.todos.length > 0) md.push("");

    for (const c of s.cards) {
      const meta = metaOf(c);
      md.push(
        `> [!${c.kindLabel}]${meta ? ` ${meta}` : ""}\n> ${c.text.split("\n").join("\n> ")}`,
      );
      md.push("");
      const tag = [c.kindLabel, meta].filter(Boolean).join(" · ");
      text.push(`- [${tag}] ${c.text.split("\n").join("\n  ")}`);
    }
    md.push("");
    text.push("");
  }

  const cards = sections.reduce((n, s) => n + s.cards.length, 0);
  const done = sections.reduce(
    (n, s) => n + s.todos.filter((t) => t.done).length,
    0,
  );
  const chips = activeChips(info.filter).map((c) => c.label);
  const meta = [
    info.label,
    `기록 ${cards}건`,
    `끝낸 할 일 ${done}건`,
    // 화면의 칩 줄과 **같은 함수**를 쓴다 — 따로 쓰면 언젠가 갈라진다
    chips.length > 0 ? `필터: ${chips.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const title = `회고 ${info.label}`;
  return {
    title,
    meta,
    html: bodyToHtml(md.join("\n")),
    text: [title, meta, "", ...text].join("\n").trimEnd() + "\n",
  };
}
