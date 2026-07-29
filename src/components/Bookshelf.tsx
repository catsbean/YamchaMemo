import { useMemo, useRef, useState } from "react";
import type { NoteSummary } from "../bindings";
import { isImeEnter } from "../lib/ime";
import { useVault } from "../stores/vault";
import {
  BOOK_STATUS_LABELS as STATUS_LABELS,
  BOOK_STATUS_ORDER as STATUS_ORDER,
  coverSrc,
  fmStr,
} from "../lib/note";
import BookCreateDialog from "./BookCreateDialog";
import BookSearchDialog from "./BookSearchDialog";
import EnrichDialog from "./EnrichDialog";

type GroupBy = "genre" | "status" | "author" | "none";
type ViewMode = "grid" | "list";

/** 저자 문자열을 개별 저자로 분리 (쉼표·세미콜론·가운뎃점) */
function splitAuthors(s: string): string[] {
  return s
    .split(/[,;·]/)
    .map((a) => a.trim())
    .filter(Boolean);
}

/** 외국인 이름 변형 통합 키: 가운데 이니셜(예: "J.") 제거 + 공백 정규화 + 소문자.
 *  예) "마커스 보그" 와 "마커스 J. 보그" 는 같은 키가 된다. */
function authorKey(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter((tok) => !/^[A-Za-z가-힣]\.?$/.test(tok))
    .join(" ")
    .toLowerCase();
}

const AUTHOR_NONE = "저자 미상";

/** 책들을 작가별로 묶는다. 다중 저자는 각 작가 그룹에 중복 편입.
 *  같은 키의 표기 변형 중 가장 자주 쓰인(동률이면 가장 긴) 이름을 그룹명으로 쓴다. */
function buildAuthorGroups(books: NoteSummary[]): [string, NoteSummary[]][] {
  const map = new Map<string, { books: NoteSummary[]; names: Map<string, number> }>();
  for (const b of books) {
    const authors = splitAuthors(fmStr(b, "author"));
    if (authors.length === 0) {
      const g = map.get("__none__") ?? { books: [] as NoteSummary[], names: new Map<string, number>() };
      g.books.push(b);
      map.set("__none__", g);
      continue;
    }
    for (const a of authors) {
      const key = authorKey(a) || "__none__";
      const g = map.get(key) ?? { books: [] as NoteSummary[], names: new Map<string, number>() };
      g.books.push(b);
      if (key !== "__none__") g.names.set(a, (g.names.get(a) ?? 0) + 1);
      map.set(key, g);
    }
  }
  const entries: [string, NoteSummary[]][] = [...map.entries()].map(([key, g]) => {
    if (key === "__none__") return [AUTHOR_NONE, g.books];
    let best = "";
    let bestCount = -1;
    for (const [name, cnt] of g.names) {
      if (cnt > bestCount || (cnt === bestCount && name.length > best.length)) {
        best = name;
        bestCount = cnt;
      }
    }
    return [best || key, g.books];
  });
  entries.sort((a, b) => {
    if (a[0] === AUTHOR_NONE) return 1;
    if (b[0] === AUTHOR_NONE) return -1;
    return a[0].localeCompare(b[0], "ko");
  });
  return entries;
}

/** 서재: 책장(그리드) / 목록(표+대량입력) 두 가지 뷰 */
export default function Bookshelf({ compact = false }: { compact?: boolean }) {
  const { notes } = useVault();
  const [view, setView] = useState<ViewMode>("grid");
  const [creating, setCreating] = useState(false);
  const [searching, setSearching] = useState(false);
  const [enriching, setEnriching] = useState(false);

  const books = useMemo(
    () => notes.filter((n) => n.note_type === "book"),
    [notes],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2">
        <h1 className="text-base font-bold">
          책장{" "}
          <span className="text-sm font-normal text-neutral-400">
            {books.length}권
          </span>
        </h1>
        <div className="flex items-center gap-1 text-xs">
          <button
            className={`rounded px-2.5 py-1 ${
              view === "grid"
                ? "bg-neutral-800 text-white"
                : "text-neutral-500 hover:bg-neutral-100"
            }`}
            onClick={() => setView("grid")}
          >
            책장
          </button>
          <button
            className={`rounded px-2.5 py-1 ${
              view === "list"
                ? "bg-neutral-800 text-white"
                : "text-neutral-500 hover:bg-neutral-100"
            }`}
            onClick={() => setView("list")}
          >
            목록
          </button>
          <button
            className="ml-2 rounded border border-neutral-300 px-3 py-1 text-neutral-600 hover:border-neutral-500"
            onClick={() => setEnriching(true)}
            title="분야·소개·표지가 비어 있는 책을 자동으로 채웁니다"
          >
            ✨ 자동 채우기
          </button>
          <button
            className="rounded bg-amber-600 px-3 py-1 text-white hover:bg-amber-500"
            onClick={() => setSearching(true)}
            title="카카오 책 검색으로 저자·출판사·표지까지 자동 입력"
          >
            🔍 검색해서 추가
          </button>
          {view === "grid" && (
            <button
              className="rounded bg-neutral-800 px-3 py-1 text-white hover:bg-neutral-600"
              onClick={() => setCreating(true)}
            >
              + 직접 입력
            </button>
          )}
        </div>
      </header>

      {view === "grid" ? (
        <GridView books={books} compact={compact} />
      ) : (
        <ListView books={books} />
      )}

      {creating && <BookCreateDialog onClose={() => setCreating(false)} />}
      {searching && <BookSearchDialog onClose={() => setSearching(false)} />}
      {enriching && <EnrichDialog onClose={() => setEnriching(false)} />}
    </div>
  );
}

// ---------- 그리드(책장) 뷰 ----------

function GridView({ books, compact }: { books: NoteSummary[]; compact: boolean }) {
  const { vaultPath, openNote, openReadingForBook } = useVault();
  const [groupBy, setGroupBy] = useState<GroupBy>("genre");
  // 그룹별 표시 on/off (분야가 많아질 때 골라 보기)
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const groups = useMemo<[string, NoteSummary[]][]>(() => {
    if (groupBy === "none") return [["전체", books]];
    if (groupBy === "author") return buildAuthorGroups(books);
    const map = new Map<string, NoteSummary[]>();
    for (const b of books) {
      const key =
        groupBy === "genre"
          ? fmStr(b, "genre") || "미분류"
          : (STATUS_LABELS[fmStr(b, "status")] ?? "기타");
      map.set(key, [...(map.get(key) ?? []), b]);
    }
    const keys = [...map.keys()];
    if (groupBy === "status") {
      const order = STATUS_ORDER.map((s) => STATUS_LABELS[s]);
      keys.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    } else {
      keys.sort((a, b) => a.localeCompare(b, "ko"));
    }
    return keys.map((k) => [k, map.get(k)!]);
  }, [books, groupBy]);

  return (
    <>
      <div className="flex gap-1 border-b border-neutral-100 px-4 py-1.5 text-xs">
        {(
          [
            ["genre", "분야별"],
            ["status", "상태별"],
            ["author", "작가별"],
            ["none", "전체"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            className={`rounded px-2.5 py-1 ${
              groupBy === v
                ? "bg-neutral-200 text-neutral-800"
                : "text-neutral-400 hover:bg-neutral-100"
            }`}
            onClick={() => {
              setGroupBy(v);
              setHidden(new Set());
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {groupBy !== "none" && groups.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-neutral-100 px-4 py-1.5">
          {groups.map(([key, list]) => {
            const off = hidden.has(key);
            return (
              <button
                key={key}
                className={`rounded-full px-2.5 py-0.5 text-xs transition-colors ${
                  off
                    ? "bg-neutral-100 text-neutral-300 line-through"
                    : "bg-neutral-800 text-white"
                }`}
                onClick={() => {
                  const next = new Set(hidden);
                  if (off) next.delete(key);
                  else next.add(key);
                  setHidden(next);
                }}
                title={off ? "다시 표시" : "숨기기"}
              >
                {key} {list.length}
              </button>
            );
          })}
          {hidden.size > 0 && (
            <button
              className="ml-1 text-xs text-neutral-400 underline hover:text-neutral-600"
              onClick={() => setHidden(new Set())}
            >
              모두 표시
            </button>
          )}
          {hidden.size < groups.length && (
            <button
              className="text-xs text-neutral-400 underline hover:text-neutral-600"
              onClick={() => setHidden(new Set(groups.map(([key]) => key)))}
            >
              모두 안 보기
            </button>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {books.length === 0 && (
          <p className="mt-16 text-center text-sm text-neutral-400">
            아직 책이 없습니다. [+ 책 추가]로 시작해 보세요.
          </p>
        )}
        {groups
          .filter(([group]) => !hidden.has(group))
          .map(([group, list]) => (
          <section key={group} className="mb-6">
            {groupBy !== "none" && (
              <h2 className="mb-2 border-b border-neutral-100 pb-1 text-sm font-semibold text-neutral-600">
                {group}{" "}
                <span className="font-normal text-neutral-400">
                  {list.length}
                </span>
              </h2>
            )}
            <div
              className={`grid gap-4 ${
                compact
                  ? "grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))]"
                  : "grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))]"
              }`}
            >
              {list.map((b) => (
                <BookCard
                  key={b.rel_path}
                  book={b}
                  cover={coverSrc(vaultPath, fmStr(b, "cover"))}
                  onOpenReading={() => openReadingForBook(b.rel_path)}
                  onOpenInfo={() => openNote(b.rel_path)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

const SPINE_COLORS = [
  "bg-rose-100 text-rose-900",
  "bg-amber-100 text-amber-900",
  "bg-emerald-100 text-emerald-900",
  "bg-sky-100 text-sky-900",
  "bg-violet-100 text-violet-900",
  "bg-stone-200 text-stone-800",
];

function spineColor(title: string): string {
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return SPINE_COLORS[Math.abs(h) % SPINE_COLORS.length];
}

function BookCard({
  book,
  cover,
  onOpenReading,
  onOpenInfo,
}: {
  book: NoteSummary;
  cover: string;
  onOpenReading: () => void;
  onOpenInfo: () => void;
}) {
  const author = fmStr(book, "author");
  const rating = fmStr(book, "rating");
  const status = fmStr(book, "status");

  return (
    <div className="group flex flex-col">
      <button
        className="relative aspect-[2/3] w-full overflow-hidden rounded-md shadow transition-transform hover:-translate-y-1 hover:shadow-lg"
        onClick={onOpenReading}
        title="클릭하면 독서기록으로 이동합니다"
      >
        {cover ? (
          <img
            src={cover}
            alt={book.title}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div
            className={`flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center ${spineColor(book.title)}`}
          >
            <span className="line-clamp-4 text-sm font-bold leading-snug">
              {book.title}
            </span>
            {author && <span className="text-[11px] opacity-70">{author}</span>}
          </div>
        )}
        {status === "reading" && (
          <span className="absolute left-1 top-1 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] text-white">
            읽는 중
          </span>
        )}
        {rating && (
          <span className="absolute right-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-amber-300">
            ★ {rating}
          </span>
        )}
      </button>
      <div className="mt-1 flex items-start justify-between gap-1">
        <span className="line-clamp-2 text-xs text-neutral-600">{book.title}</span>
        <button
          className="shrink-0 rounded px-1 text-[11px] text-neutral-400 opacity-0 transition-opacity hover:bg-neutral-100 hover:text-neutral-700 group-hover:opacity-100"
          onClick={onOpenInfo}
          title="책 정보 노트 열기"
        >
          정보
        </button>
      </div>
    </div>
  );
}

// ---------- 목록(표) 뷰: 인라인 편집 + 대량 입력 ----------

function ListView({ books }: { books: NoteSummary[] }) {
  const { openNote, openReadingForBook, updateFrontmatter, refresh } =
    useVault();
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState("");

  async function runBulk() {
    if (bulkBusy) return;
    setBulkBusy(true);
    setBulkResult("");
    let ok = 0;
    let fail = 0;
    const { commands } = await import("../bindings");
    for (const line of bulkText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // 탭(Excel) → | → 쉼표 순으로 구분자 인식
      const sep = trimmed.includes("\t") ? "\t" : trimmed.includes("|") ? "|" : ",";
      const [title, author, genre, status] = trimmed
        .split(sep)
        .map((s) => s.trim());
      if (!title) continue;
      const fields: Record<string, string> = {};
      if (author) fields.author = author;
      if (genre) fields.genre = genre;
      // 상태: 라벨 또는 값으로 인식
      if (status) {
        const byValue = Object.keys(STATUS_LABELS).find((k) => k === status);
        const byLabel = Object.entries(STATUS_LABELS).find(
          ([, l]) => l === status,
        )?.[0];
        const s = byValue ?? byLabel;
        if (s) fields.status = s;
      }
      const r = await commands.createNote("book", title, fields);
      if (r.status === "ok") ok += 1;
      else fail += 1;
    }
    await refresh();
    setBulkResult(`${ok}권 등록${fail ? `, ${fail}건 실패` : ""}`);
    if (ok > 0) setBulkText("");
    setBulkBusy(false);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-neutral-100 px-4 py-1.5">
        <button
          className="text-xs text-neutral-500 underline hover:text-neutral-700"
          onClick={() => setBulkOpen((v) => !v)}
        >
          {bulkOpen ? "대량 입력 닫기" : "대량 입력 열기 (Excel/텍스트 붙여넣기)"}
        </button>
        {bulkOpen && (
          <div className="mt-2 flex flex-col gap-2 pb-2">
            <p className="text-[11px] text-neutral-400">
              한 줄에 한 권 — <b>제목, 저자, 분야, 상태</b> 순서. 구분자는
              탭(Excel 복사), <code>|</code>, 쉼표 모두 인식. 제목만 있어도
              됩니다.
            </p>
            <textarea
              className="h-28 w-full resize-y rounded border border-neutral-300 px-2 py-1 font-mono text-xs focus:border-neutral-500 focus:outline-none"
              placeholder={"클린 코드\t로버트 마틴\t개발\t완독\n노르웨이의 숲, 무라카미 하루키, 소설"}
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <button
                className="self-start rounded bg-neutral-800 px-3 py-1 text-xs text-white hover:bg-neutral-600 disabled:opacity-50"
                disabled={bulkBusy || !bulkText.trim()}
                onClick={runBulk}
              >
                {bulkBusy ? "등록 중…" : "일괄 등록"}
              </button>
              {bulkResult && (
                <span className="text-xs text-emerald-600">{bulkResult}</span>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[40rem] border-collapse text-sm">
          <thead className="sticky top-0 bg-neutral-50 text-xs text-neutral-500">
            <tr>
              <th className="border-b border-neutral-200 px-3 py-2 text-left">제목</th>
              <th className="w-32 border-b border-neutral-200 px-2 py-2 text-left">저자</th>
              <th className="w-24 border-b border-neutral-200 px-2 py-2 text-left">분야</th>
              <th className="w-28 border-b border-neutral-200 px-2 py-2 text-left">상태</th>
              <th className="w-16 border-b border-neutral-200 px-2 py-2 text-left">평점</th>
              <th className="w-20 border-b border-neutral-200 px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {books.map((b) => (
              <BookRow
                key={b.rel_path}
                book={b}
                onOpen={() => openNote(b.rel_path)}
                onOpenReading={() => openReadingForBook(b.rel_path)}
                onPatch={(patch) => updateFrontmatter(b.rel_path, patch)}
              />
            ))}
            <NewBookInlineRow onCreated={refresh} />
          </tbody>
        </table>
      </div>
    </div>
  );
}

const EMPTY_BOOK = { title: "", author: "", genre: "", status: "wishlist", rating: "" };

/** 표 맨 아래 빈 행: 제목을 쓰고 Enter → 즉시 등록, 다음 입력으로 이어짐 */
function NewBookInlineRow({ onCreated }: { onCreated: () => Promise<void> }) {
  const [row, setRow] = useState({ ...EMPTY_BOOK });
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  async function commit() {
    const title = row.title.trim();
    if (busy || !title) return;
    setBusy(true);
    const fields: Record<string, string | number> = { status: row.status };
    if (row.author.trim()) fields.author = row.author.trim();
    if (row.genre.trim()) fields.genre = row.genre.trim();
    if (row.rating.trim() && !Number.isNaN(Number(row.rating))) {
      fields.rating = Number(row.rating);
    }
    const { commands } = await import("../bindings");
    const r = await commands.createNote("book", title, fields);
    if (r.status === "ok") {
      setRow({ ...EMPTY_BOOK });
      await onCreated();
      titleRef.current?.focus();
    }
    setBusy(false);
  }

  const cellCls =
    "w-full rounded border border-dashed border-neutral-200 bg-transparent px-1.5 py-1 placeholder-neutral-300 focus:border-solid focus:border-neutral-400 focus:bg-white focus:outline-none";
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !isImeEnter(e)) commit();
  };

  return (
    <tr className="bg-neutral-50/60">
      <td className="px-3 py-1">
        <input
          ref={titleRef}
          className={cellCls}
          placeholder="+ 새 책 제목 입력 후 Enter"
          value={row.title}
          onChange={(e) => setRow((r) => ({ ...r, title: e.target.value }))}
          onKeyDown={onEnter}
        />
      </td>
      <td className="px-1 py-1">
        <input
          className={cellCls}
          placeholder="저자"
          value={row.author}
          onChange={(e) => setRow((r) => ({ ...r, author: e.target.value }))}
          onKeyDown={onEnter}
        />
      </td>
      <td className="px-1 py-1">
        <input
          className={cellCls}
          placeholder="분야"
          value={row.genre}
          onChange={(e) => setRow((r) => ({ ...r, genre: e.target.value }))}
          onKeyDown={onEnter}
        />
      </td>
      <td className="px-1 py-1">
        <select
          className="w-full rounded border border-dashed border-neutral-200 bg-transparent px-1 py-1 focus:border-neutral-400 focus:outline-none"
          value={row.status}
          onChange={(e) => setRow((r) => ({ ...r, status: e.target.value }))}
        >
          {Object.entries(STATUS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </td>
      <td className="px-1 py-1">
        <input
          type="number"
          min={0}
          max={5}
          step={0.5}
          className={cellCls}
          placeholder="-"
          value={row.rating}
          onChange={(e) => setRow((r) => ({ ...r, rating: e.target.value }))}
          onKeyDown={onEnter}
        />
      </td>
      <td className="px-1 py-1 text-right">
        <button
          className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] text-white hover:bg-neutral-600 disabled:opacity-40"
          disabled={busy || !row.title.trim()}
          onClick={commit}
        >
          추가
        </button>
      </td>
    </tr>
  );
}

function EditCell({
  value,
  onCommit,
  width = "",
  number = false,
}: {
  value: string;
  onCommit: (v: string) => void;
  width?: string;
  number?: boolean;
}) {
  const [v, setV] = useState(value);
  // 외부 갱신 반영
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    setV(value);
  }
  return (
    <input
      type={number ? "number" : "text"}
      min={number ? 0 : undefined}
      max={number ? 5 : undefined}
      step={number ? 0.5 : undefined}
      className={`w-full rounded border border-transparent bg-transparent px-1.5 py-1 hover:border-neutral-200 focus:border-neutral-400 focus:bg-white focus:outline-none ${width}`}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v !== value) onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function BookRow({
  book,
  onOpen,
  onOpenReading,
  onPatch,
}: {
  book: NoteSummary;
  onOpen: () => void;
  onOpenReading: () => void;
  onPatch: (patch: Record<string, string | number | null>) => void;
}) {
  return (
    <tr className="border-b border-neutral-100 hover:bg-neutral-50">
      <td className="px-3 py-1">
        <button
          className="w-full truncate text-left font-medium hover:underline"
          onClick={onOpen}
          title={book.rel_path}
        >
          {book.title}
        </button>
      </td>
      <td className="px-1 py-1">
        <EditCell
          value={fmStr(book, "author")}
          onCommit={(v) => onPatch({ author: v || null })}
        />
      </td>
      <td className="px-1 py-1">
        <EditCell
          value={fmStr(book, "genre")}
          onCommit={(v) => onPatch({ genre: v || null })}
        />
      </td>
      <td className="px-1 py-1">
        <select
          className="w-full rounded border border-transparent bg-transparent px-1 py-1 hover:border-neutral-200 focus:border-neutral-400 focus:outline-none"
          value={fmStr(book, "status") || "wishlist"}
          onChange={(e) => onPatch({ status: e.target.value })}
        >
          {Object.entries(STATUS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </td>
      <td className="px-1 py-1">
        <EditCell
          number
          value={fmStr(book, "rating")}
          onCommit={(v) => onPatch({ rating: v === "" ? null : Number(v) })}
        />
      </td>
      <td className="px-1 py-1 text-right">
        <button
          className="rounded bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700 hover:bg-amber-100"
          onClick={onOpenReading}
        >
          독서기록
        </button>
      </td>
    </tr>
  );
}
