import { useState } from "react";
import type { NoteSummary } from "../bindings";
import { BOOK_STATUS_LABELS, fmStr } from "../lib/note";
import { saveTextAs } from "../lib/exportFile";
import { toCsv, toMarkdownTable, type Column } from "../lib/exportTable";
import Modal from "./Modal";

/** 고를 수 있는 항목. 순서가 곧 표의 열 순서다. */
const COLUMNS: Column<NoteSummary>[] = [
  { id: "title", label: "제목", value: (b) => b.title },
  { id: "author", label: "저자", value: (b) => fmStr(b, "author") },
  { id: "genre", label: "분야", value: (b) => fmStr(b, "genre") },
  {
    id: "status",
    label: "상태",
    value: (b) => BOOK_STATUS_LABELS[fmStr(b, "status")] ?? "",
  },
  { id: "rating", label: "별점", value: (b) => fmStr(b, "rating") },
  { id: "started", label: "시작", value: (b) => fmStr(b, "started") },
  { id: "finished", label: "완독", value: (b) => fmStr(b, "finished") },
  { id: "publisher", label: "출판사", value: (b) => fmStr(b, "publisher") },
  { id: "tags", label: "태그", value: (b) => b.tags.join(" ") },
  { id: "entries", label: "기록 수", value: (b) => String(b.entry_count) },
];

const DEFAULT_ON = new Set(["title", "author", "genre", "status", "rating", "finished"]);

/** 책 목록 내보내기 — 지금 화면에 보이는 책과 순서를 그대로 쓴다. */
export default function ExportBooksDialog({
  books,
  onClose,
}: {
  /** 지금 화면의 필터·정렬이 적용된 목록 */
  books: NoteSummary[];
  onClose: () => void;
}) {
  const [on, setOn] = useState<Set<string>>(new Set(DEFAULT_ON));
  const [format, setFormat] = useState<"csv" | "md">("csv");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const cols = COLUMNS.filter((c) => on.has(c.id));

  async function run() {
    if (busy || cols.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const text =
        format === "csv" ? toCsv(books, cols) : toMarkdownTable(books, cols);
      const saved = await saveTextAs(
        "책 목록",
        format === "csv" ? "csv" : "md",
        format === "csv" ? "CSV (엑셀)" : "마크다운",
        text,
      );
      if (saved) onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const preview = cols.length
    ? toMarkdownTable(books.slice(0, 3), cols)
    : "항목을 하나 이상 고르세요.";

  return (
    <Modal onClose={onClose} panelClassName="w-[30rem] rounded-lg p-5 shadow-xl">
      <h2 className="mb-1 text-base font-bold">책 목록 내보내기</h2>
      <p className="mb-4 text-xs text-neutral-500">
        지금 화면에 보이는 {books.length}권을 그 순서대로 내보냅니다.
      </p>

      <h3 className="mb-1.5 text-sm font-semibold text-neutral-600">형식</h3>
      <div className="mb-4 flex gap-1.5 text-sm">
        {(
          [
            ["csv", "CSV", "엑셀에서 바로 열립니다"],
            ["md", "마크다운 표", "노트에 붙여 넣기 좋습니다"],
          ] as const
        ).map(([v, label, desc]) => (
          <button
            key={v}
            className={`flex-1 rounded-md border px-3 py-2 text-left ${
              format === v
                ? "border-neutral-800 bg-neutral-50 font-medium"
                : "border-neutral-200 text-neutral-500 hover:border-neutral-400"
            }`}
            onClick={() => setFormat(v)}
          >
            <span className="block">{label}</span>
            <span className="block text-2xs text-neutral-400">{desc}</span>
          </button>
        ))}
      </div>

      <h3 className="mb-1.5 text-sm font-semibold text-neutral-600">내보낼 항목</h3>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {COLUMNS.map((c) => {
          const active = on.has(c.id);
          return (
            <button
              key={c.id}
              className={`rounded-full border px-2.5 py-1 text-xs ${
                active
                  ? "border-neutral-800 bg-neutral-800 text-white"
                  : "border-neutral-300 text-neutral-500 hover:border-neutral-500"
              }`}
              onClick={() =>
                setOn((s) => {
                  const next = new Set(s);
                  if (next.has(c.id)) next.delete(c.id);
                  else next.add(c.id);
                  return next;
                })
              }
            >
              {c.label}
            </button>
          );
        })}
      </div>

      <pre className="mb-4 max-h-28 overflow-auto rounded border border-neutral-200 bg-neutral-50 p-2 text-3xs leading-relaxed text-neutral-600">
        {preview}
      </pre>

      {error && <p className="mb-2 text-xs text-rose-500">{error}</p>}

      <div className="flex justify-end gap-2">
        <button
          className="rounded px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100"
          onClick={onClose}
        >
          취소
        </button>
        <button
          className="rounded bg-neutral-800 px-4 py-1.5 text-sm text-white hover:bg-neutral-600 disabled:opacity-40"
          disabled={busy || cols.length === 0}
          onClick={run}
        >
          저장
        </button>
      </div>
    </Modal>
  );
}
