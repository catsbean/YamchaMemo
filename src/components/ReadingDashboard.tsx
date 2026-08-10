import { useEffect, useMemo, useState } from "react";
import { commands, type ReadingEntry } from "../bindings";
import { useVault } from "../stores/vault";
import { coverSrc } from "../lib/note";
import { printHtml, saveTextAs } from "../lib/exportFile";
import { wrapDocument } from "../lib/exportHtml";
import { buildReadingDoc } from "../lib/exportNote";
import { useContextMenu, type MenuItem } from "../lib/contextMenu";
import BookPickerDialog from "./BookPickerDialog";
import ContextMenu from "./ContextMenu";

/** 종류별 색 — 편집기 콜아웃(livePreview.ts)과 같은 계열로 맞춘다 */
const KIND_STYLE: Record<string, string> = {
  발췌: "bg-amber-50 text-amber-700 ring-amber-200",
  생각: "bg-sky-50 text-sky-700 ring-sky-200",
  요약: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  질문: "bg-violet-50 text-violet-700 ring-violet-200",
};
const KIND_ORDER = ["발췌", "생각", "요약", "질문"];

const PERIODS: [number, string][] = [
  [0, "전체 기간"],
  [30, "최근 1개월"],
  [180, "최근 6개월"],
  [365, "최근 1년"],
];

const SORTS: [Sort, string][] = [
  ["new", "최신순"],
  ["old", "오래된순"],
  ["book", "책별"],
  ["genre", "장르별"],
];

type Sort = "new" | "old" | "book" | "genre";

/** n일 전 날짜 (로컬 기준 — toISOString은 UTC라 하루가 밀린다) */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 독서기록 대시보드 — 책이 아니라 **기록 한 줄 한 줄**을 모아 본다.
 *  쌓아 두기만 하고 다시 꺼내 볼 화면이 없으면 기록할 이유가 사라지기 때문이다. */
export default function ReadingDashboard() {
  const { vaultPath, notes, openNote, callouts } = useVault();
  const [entries, setEntries] = useState<ReadingEntry[] | null>(null);
  const [picking, setPicking] = useState(false);

  const [kinds, setKinds] = useState<string[]>([]);
  const [book, setBook] = useState("");
  const [genre, setGenre] = useState("");
  const [tag, setTag] = useState("");
  const [days, setDays] = useState(0);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("new");
  const [shuffleSeed, setShuffleSeed] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  // notes가 바뀌면(저장·기록 추가) 다시 읽는다
  useEffect(() => {
    commands.listEntries().then((r) => setEntries(r.status === "ok" ? r.data : []));
  }, [notes]);

  const all = entries ?? [];

  const kindCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of all) m.set(e.kind_label, (m.get(e.kind_label) ?? 0) + 1);
    return m;
  }, [all]);

  const kindList = useMemo(() => {
    const known = KIND_ORDER.filter((k) => kindCounts.has(k));
    const extra = [...kindCounts.keys()].filter((k) => !KIND_ORDER.includes(k)).sort();
    return [...known, ...extra];
  }, [kindCounts]);

  const books = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of all) m.set(e.book_rel, e.book_title);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], "ko"));
  }, [all]);

  const genres = useMemo(() => {
    const s = new Set<string>();
    for (const e of all) if (e.genre) s.add(e.genre);
    return [...s].sort((a, b) => a.localeCompare(b, "ko"));
  }, [all]);

  const tags = useMemo(() => {
    const s = new Set<string>();
    for (const e of all) for (const t of e.tags) s.add(t);
    return [...s].sort((a, b) => a.localeCompare(b, "ko"));
  }, [all]);

  const filtered = useMemo(() => {
    const since = days > 0 ? daysAgo(days) : "";
    const needle = q.trim().toLowerCase();
    const list = all.filter((e) => {
      if (kinds.length > 0 && !kinds.includes(e.kind_label)) return false;
      if (book && e.book_rel !== book) return false;
      if (genre && e.genre !== genre) return false;
      if (tag && !e.tags.includes(tag)) return false;
      // 날짜가 없는 기록(외부에서 넣은 콜아웃)은 기간 필터에서 걸러내지 않는다
      if (since && e.date && e.date < since) return false;
      if (needle && !e.text.toLowerCase().includes(needle)) return false;
      return true;
    });
    list.sort((a, b) => {
      if (sort === "book") {
        return a.book_title.localeCompare(b.book_title, "ko") || b.date.localeCompare(a.date);
      }
      if (sort === "genre") {
        // 분야가 없는 책은 뒤로 (빈 문자열이 앞에 몰리면 읽기 나쁘다)
        const ga = a.genre || "￿";
        const gb = b.genre || "￿";
        return (
          ga.localeCompare(gb, "ko") ||
          a.book_title.localeCompare(b.book_title, "ko") ||
          b.date.localeCompare(a.date)
        );
      }
      const cmp = a.date.localeCompare(b.date);
      return sort === "old" ? cmp : -cmp;
    });
    return list;
  }, [all, kinds, book, genre, tag, days, q, sort]);

  // 🎲 랜덤 보기: 필터 결과에서 무작위 3개
  const shown = useMemo(() => {
    if (shuffleSeed === 0) return filtered;
    const pool = [...filtered];
    const out: ReadingEntry[] = [];
    while (pool.length > 0 && out.length < 3) {
      out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    return out;
  }, [filtered, shuffleSeed]);

  const hasFilter =
    kinds.length > 0 || !!book || !!genre || !!tag || days > 0 || !!q.trim();

  const exportMenu = useContextMenu();

  function toggleKind(k: string) {
    setKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
    setShuffleSeed(0);
  }

  function resetFilters() {
    setKinds([]);
    setBook("");
    setGenre("");
    setTag("");
    setDays(0);
    setQ("");
    setShuffleSeed(0);
  }

  /** 지금 화면에 보이는 기록을 그대로 문서로 — 필터·정렬이 곧 내보낼 범위다 */
  function readingDoc() {
    const d = buildReadingDoc(shown, callouts);
    return { ...d, wrapped: wrapDocument(d.title, d.html, d.meta, callouts) };
  }

  const exportItems: MenuItem[] = [
    {
      label: "🖨️ 인쇄 · PDF로 저장",
      hint: "인쇄 창에서 PDF 선택",
      onClick: () => void printHtml(readingDoc().wrapped),
    },
    {
      label: "📄 텍스트로 저장",
      hint: "글자만 — 어디에나 붙여넣기",
      onClick: async () => {
        const d = readingDoc();
        await saveTextAs("독서기록", "txt", "텍스트", d.text);
      },
    },
    {
      label: "🖼️ HTML로 저장",
      hint: "스타일까지 한 파일",
      onClick: async () => {
        const d = readingDoc();
        await saveTextAs("독서기록", "html", "HTML 문서", d.wrapped);
      },
    },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-3">
        <h1 className="text-lg font-bold">
          독서기록{" "}
          <span className="text-sm font-normal text-neutral-400">
            기록 {all.length}개 · 책 {books.length}권
          </span>
        </h1>
        <div className="flex gap-2">
          <button
            className={`rounded border px-3 py-1.5 text-sm ${
              shuffleSeed > 0
                ? "border-amber-400 bg-amber-50 text-amber-700"
                : "border-neutral-300 hover:border-neutral-500"
            }`}
            onClick={() => setShuffleSeed(shuffleSeed > 0 ? 0 : Date.now())}
            title="지금 조건에 맞는 기록 중 무작위 3개만 보여줍니다 (다시 누르면 해제)"
          >
            🎲 랜덤 보기
          </button>
          <button
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 hover:border-neutral-500 disabled:opacity-40"
            disabled={shown.length === 0}
            onClick={(ev) => {
              const r = ev.currentTarget.getBoundingClientRect();
              exportMenu.open(
                { clientX: r.right - 180, clientY: r.bottom + 2, preventDefault: () => {} },
                exportItems,
              );
            }}
            title="지금 화면에 보이는 기록을 문서로 냅니다"
          >
            ⬇ 내보내기
          </button>
          <button
            className="rounded bg-neutral-800 px-3 py-1.5 text-sm text-white hover:bg-neutral-600"
            onClick={() => setPicking(true)}
          >
            새로 만들기
          </button>
        </div>
      </header>

      {/* 필터 바 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-100 px-6 py-2">
        {kindList.map((k) => (
          <button
            key={k}
            className={`rounded-full px-2.5 py-0.5 text-xs ring-1 ${
              kinds.includes(k)
                ? "bg-neutral-800 text-white ring-neutral-800"
                : (KIND_STYLE[k] ?? "bg-neutral-50 text-neutral-600 ring-neutral-200")
            }`}
            onClick={() => toggleKind(k)}
          >
            {k} {kindCounts.get(k)}
          </button>
        ))}

        <select
          className="rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-500 focus:outline-none"
          value={book}
          onChange={(e) => {
            setBook(e.target.value);
            setShuffleSeed(0);
          }}
        >
          <option value="">모든 책</option>
          {books.map(([rel, title]) => (
            <option key={rel} value={rel}>
              {title}
            </option>
          ))}
        </select>

        {genres.length > 0 && (
          <select
            className="rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-500 focus:outline-none"
            value={genre}
            onChange={(e) => {
              setGenre(e.target.value);
              setShuffleSeed(0);
            }}
          >
            <option value="">모든 분야</option>
            {genres.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        )}

        {tags.length > 0 && (
          <select
            className="rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-500 focus:outline-none"
            value={tag}
            onChange={(e) => {
              setTag(e.target.value);
              setShuffleSeed(0);
            }}
          >
            <option value="">모든 태그</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                #{t}
              </option>
            ))}
          </select>
        )}

        <select
          className="rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-500 focus:outline-none"
          value={days}
          onChange={(e) => {
            setDays(Number(e.target.value));
            setShuffleSeed(0);
          }}
        >
          {PERIODS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>

        <input
          className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-500 focus:outline-none"
          placeholder="기록 내용 검색…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setShuffleSeed(0);
          }}
        />

        <select
          className="rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-500 focus:outline-none"
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
        >
          {SORTS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>

        {hasFilter && (
          <button
            className="text-xs text-neutral-500 underline hover:text-neutral-800"
            onClick={resetFilters}
          >
            초기화
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {entries === null && (
          <p className="mt-16 text-center text-sm text-neutral-400">불러오는 중…</p>
        )}
        {entries !== null && all.length === 0 && (
          <p className="mt-16 text-center text-sm text-neutral-400">
            아직 기록이 없습니다. [새로 만들기]로 책을 골라 발췌·생각을
            남겨보세요.
          </p>
        )}
        {entries !== null && all.length > 0 && shown.length === 0 && (
          <p className="mt-16 text-center text-sm text-neutral-400">
            조건에 맞는 기록이 없습니다. 필터를 바꿔보세요.
          </p>
        )}

        <ul className="flex flex-col gap-2">
          {shown.map((e, i) => {
            const id = `${e.book_rel}#${i}#${e.date}`;
            const url = coverSrc(vaultPath, e.cover);
            const open = expanded === id;
            return (
              <li
                key={id}
                className="rounded-lg border border-neutral-200 bg-white p-3 shadow-sm"
              >
                <div className="flex items-start gap-3">
                  {url ? (
                    <img
                      src={url}
                      alt=""
                      className="h-14 w-10 shrink-0 cursor-pointer rounded object-cover shadow-sm"
                      onClick={() => openNote(e.book_rel)}
                    />
                  ) : (
                    <div
                      className="flex h-14 w-10 shrink-0 cursor-pointer items-center justify-center rounded bg-neutral-100 text-xs"
                      onClick={() => openNote(e.book_rel)}
                    >
                      📖
                    </div>
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <button
                        className="min-w-0 truncate text-xs font-medium text-neutral-700 hover:underline"
                        onClick={() => openNote(e.book_rel)}
                      >
                        {e.book_title}
                        {e.book_author && (
                          <span className="text-neutral-400"> · {e.book_author}</span>
                        )}
                        {e.genre && (
                          <span className="text-neutral-400"> · {e.genre}</span>
                        )}
                      </button>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-2xs ring-1 ${
                          KIND_STYLE[e.kind_label] ??
                          "bg-neutral-50 text-neutral-600 ring-neutral-200"
                        }`}
                      >
                        {e.kind_label}
                      </span>
                      <span className="ml-auto shrink-0 text-2xs text-neutral-400">
                        {e.date}
                      </span>
                    </div>

                    <p
                      className={`selectable mt-1.5 cursor-text whitespace-pre-wrap text-sm leading-relaxed text-neutral-800 ${
                        open ? "" : "line-clamp-4"
                      }`}
                      onClick={() => {
                        // 글자를 끌어 고르는 중이면 펼치기로 받지 않는다 —
                        // 안 그러면 복사하려고 드래그할 때마다 접혔다 펴진다
                        if (window.getSelection()?.toString()) return;
                        setExpanded(open ? null : id);
                      }}
                      title={open ? "접기" : "펼치기"}
                    >
                      {e.text || <span className="text-neutral-300">(빈 기록)</span>}
                    </p>
                  </div>

                  <button
                    className="shrink-0 rounded border border-neutral-200 px-2 py-1 text-2xs text-neutral-500 hover:border-neutral-400"
                    onClick={() => navigator.clipboard.writeText(e.text)}
                    title="기록 내용만 복사합니다"
                  >
                    복사
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {exportMenu.menu && (
        <ContextMenu state={exportMenu.menu} onClose={exportMenu.close} />
      )}
      {picking && <BookPickerDialog onClose={() => setPicking(false)} />}
    </div>
  );
}
