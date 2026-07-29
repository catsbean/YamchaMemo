// 책 목록처럼 표로 다루는 것을 CSV·마크다운 표로 내보낸다.
// (본문 노트는 `exportHtml.ts`가 맡는다)

export interface Column<T> {
  id: string;
  label: string;
  value: (row: T) => string;
}

/** CSV 한 칸 — 쉼표·따옴표·줄바꿈이 있으면 감싸고, 안의 따옴표는 겹쳐 쓴다 */
function cell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** 엑셀에서 한글이 깨지지 않게 BOM을 앞에 붙인다 (엑셀은 BOM 없으면 ANSI로 읽는다) */
export function toCsv<T>(rows: T[], cols: Column<T>[]): string {
  const head = cols.map((c) => cell(c.label)).join(",");
  const body = rows.map((r) => cols.map((c) => cell(c.value(r))).join(",")).join("\r\n");
  return `﻿${head}\r\n${body}\r\n`;
}

/** 마크다운 표 — 노트에 붙여 넣기 좋게 */
export function toMarkdownTable<T>(rows: T[], cols: Column<T>[]): string {
  const escape = (v: string) => v.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const head = `| ${cols.map((c) => escape(c.label)).join(" | ")} |`;
  const rule = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((r) => `| ${cols.map((c) => escape(c.value(r))).join(" | ")} |`)
    .join("\n");
  return [head, rule, body].join("\n") + "\n";
}
