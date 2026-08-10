import { useState } from "react";
import { commands, type NoteSummary } from "../bindings";
import { BOOK_STATUS_LABELS, fmStr } from "../lib/note";
import { printHtml, saveTextAs } from "../lib/exportFile";
import { joinSections, wrapDocument } from "../lib/exportHtml";
import { buildNoteDoc, type NoteDoc } from "../lib/exportNote";
import { toCsv, toMarkdownTable, type Column } from "../lib/exportTable";
import { useVault } from "../stores/vault";
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

/** 내보내기 — 목록(표)과 책 내용을 한 자리에서.
 *
 *  예전에는 목록은 책장에서, 책 내용은 책을 하나 연 뒤에야 내보낼 수 있었다.
 *  같은 "내보내기"인데 들어가는 문이 둘이라 헷갈렸다. 탭 하나로 합치고,
 *  책 내용은 여러 권을 골라 한 문서로 낼 수 있게 했다. */
export default function ExportBooksDialog({
  books,
  onClose,
}: {
  /** 지금 화면의 필터·정렬이 적용된 목록 */
  books: NoteSummary[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"table" | "content">("table");
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
    <Modal onClose={onClose} panelClassName="w-[32rem] rounded-lg p-5 shadow-xl">
      <h2 className="mb-3 text-base font-bold">내보내기</h2>

      <div className="mb-4 flex gap-1 border-b border-neutral-200 text-sm">
        {(
          [
            ["table", "목록 (표)"],
            ["content", "책 내용"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            className={`-mb-px border-b-2 px-3 py-1.5 ${
              tab === v
                ? "border-neutral-800 font-semibold text-neutral-800"
                : "border-transparent text-neutral-400 hover:text-neutral-600"
            }`}
            onClick={() => setTab(v)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "content" ? (
        <BookContentTab books={books} onClose={onClose} />
      ) : (
        <>
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
        </>
      )}
    </Modal>
  );
}

/** 책 내용 탭 — 여러 권을 골라 한 문서로 낸다.
 *
 *  목록(NoteSummary)에는 본문이 없으므로 내보낼 때 고른 책만 읽어 온다.
 *  전부 미리 읽으면 책이 많을 때 대화상자를 여는 것만으로 느려진다. */
function BookContentTab({
  books,
  onClose,
}: {
  books: NoteSummary[];
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const callouts = useVault((s) => s.callouts);

  const chosen = books.filter((b) => picked.has(b.rel_path));
  const allOn = picked.size === books.length && books.length > 0;

  function toggle(rel: string) {
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }

  /** 고른 책을 읽어 한 문서로 묶는다 */
  async function build(): Promise<{ name: string; html: string; text: string }> {
    const docs: NoteDoc[] = [];
    for (const b of chosen) {
      const r = await commands.readNote(b.rel_path);
      if (r.status !== "ok") throw new Error(r.error);
      docs.push(buildNoteDoc(r.data, callouts));
    }
    const name = docs.length === 1 ? docs[0].title : `책 기록 ${docs.length}권`;
    return {
      name,
      html: wrapDocument(name, joinSections(docs), "", callouts),
      text: docs.map((d) => d.text).join("\n\n\n"),
    };
  }

  async function run(how: "print" | "html" | "txt") {
    if (busy || chosen.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const d = await build();
      if (how === "print") {
        await printHtml(d.html);
        onClose();
        return;
      }
      const saved =
        how === "html"
          ? await saveTextAs(d.name, "html", "HTML 문서", d.html)
          : await saveTextAs(d.name, "txt", "텍스트", d.text);
      if (saved) onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs text-neutral-500">
          고른 책의 소개와 기록을 한 문서로 냅니다.
        </p>
        <button
          className="text-xs text-neutral-500 underline hover:text-neutral-800"
          onClick={() =>
            setPicked(allOn ? new Set() : new Set(books.map((b) => b.rel_path)))
          }
        >
          {allOn ? "전체 해제" : `전체 선택 (${books.length})`}
        </button>
      </div>

      <ul className="mb-3 max-h-64 overflow-y-auto rounded border border-neutral-200">
        {books.map((b) => {
          const active = picked.has(b.rel_path);
          return (
            <li key={b.rel_path}>
              <button
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-neutral-50 ${
                  active ? "bg-neutral-50" : ""
                }`}
                onClick={() => toggle(b.rel_path)}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-2xs ${
                    active
                      ? "border-neutral-800 bg-neutral-800 text-white"
                      : "border-neutral-300"
                  }`}
                >
                  {active ? "✓" : ""}
                </span>
                <span className="min-w-0 flex-1 truncate">{b.title}</span>
                <span className="shrink-0 text-2xs text-neutral-400">
                  기록 {b.entry_count}
                </span>
              </button>
            </li>
          );
        })}
        {books.length === 0 && (
          <li className="px-3 py-6 text-center text-xs text-neutral-400">
            책이 없습니다.
          </li>
        )}
      </ul>

      {error && <p className="mb-2 text-xs text-rose-500">{error}</p>}

      <div className="flex items-center justify-between">
        <span className="text-xs text-neutral-500">
          {chosen.length > 0 ? `${chosen.length}권 선택됨` : "책을 고르세요"}
        </span>
        <div className="flex gap-2">
          <button
            className="rounded px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100"
            onClick={onClose}
          >
            취소
          </button>
          <button
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 hover:border-neutral-500 disabled:opacity-40"
            disabled={busy || chosen.length === 0}
            onClick={() => run("txt")}
          >
            텍스트
          </button>
          <button
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 hover:border-neutral-500 disabled:opacity-40"
            disabled={busy || chosen.length === 0}
            onClick={() => run("html")}
          >
            HTML
          </button>
          <button
            className="rounded bg-neutral-800 px-4 py-1.5 text-sm text-white hover:bg-neutral-600 disabled:opacity-40"
            disabled={busy || chosen.length === 0}
            onClick={() => run("print")}
          >
            인쇄 · PDF
          </button>
        </div>
      </div>
    </>
  );
}
