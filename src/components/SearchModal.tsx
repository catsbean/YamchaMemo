import { useEffect, useMemo, useRef, useState } from "react";
import { commands, type SearchHit } from "../bindings";
import { typeLabel, useVault } from "../stores/vault";
import { isImeEnter } from "../lib/ime";
import { openNoteWindow } from "../lib/trashWindow";
import Modal from "./Modal";

/** 쿼리 토큰을 <mark>로 강조 */
function Highlight({ text, query }: { text: string; query: string }) {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (tokens.length === 0) return <>{text}</>;
  const re = new RegExp(`(${tokens.join("|")})`, "gi");
  // 캡처 그룹 split: 홀수 인덱스가 매치된 부분
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-amber-200 px-0.5">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

const PERIODS: [number, string][] = [
  [0, "전체 기간"],
  [7, "1주"],
  [30, "1개월"],
  [365, "1년"],
];

/** Ctrl+K 전문검색 — 제목/본문/태그, 한국어 부분 문자열 지원 */
export default function SearchModal({ onClose }: { onClose: () => void }) {
  const openNote = useVault((s) => s.openNote);
  const schemas = useVault((s) => s.schemas);
  const searchFuzzy = useVault((s) => s.searchFuzzy);
  const toggleSearchFuzzy = useVault((s) => s.toggleSearchFuzzy);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [selected, setSelected] = useState(0);
  const [types, setTypes] = useState<string[]>([]);
  const [days, setDays] = useState(0);
  const [tags, setTags] = useState<string[]>([]);
  const [allTagsOpen, setAllTagsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const notes = useVault((s) => s.notes);

  const filterCount = types.length + tags.length + (days > 0 ? 1 : 0);

  // 많이 쓴 태그를 앞에 (태그가 수십 개가 되면 다 늘어놓을 수 없다)
  const tagList = useMemo(() => {
    const count = new Map<string, number>();
    for (const n of notes) for (const t of n.tags) count.set(t, (count.get(t) ?? 0) + 1);
    return [...count.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"))
      .map(([t]) => t);
  }, [notes]);
  // 고른 태그는 접혀 있어도 늘 보이게
  const shownTags = allTagsOpen
    ? tagList
    : [...new Set([...tags, ...tagList.slice(0, 8)])];

  // 디바운스 검색
  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      setSelected(0);
      return;
    }
    const t = setTimeout(async () => {
      // 1단계 — 노트 결과. 첨부 검색(2단계)은 5-3에서 붙는다.
      const r = await commands.search(query, {
        types,
        days,
        tags,
        scope: "Notes",
        fuzzy: searchFuzzy,
      });
      if (r.status === "ok") {
        setHits(r.data);
        setSelected(0);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [query, types, days, tags, searchFuzzy]);

  function toggleType(id: string) {
    setTypes((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function open(hit: SearchHit) {
    await openNote(hit.rel_path);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && !isImeEnter(e) && hits[selected]) {
      open(hits[selected]);
    }
  }

  return (
    <Modal
      onClose={onClose}
      align="top"
      panelClassName="w-[34rem] overflow-hidden rounded-xl shadow-2xl"
    >
      <input
          ref={inputRef}
          autoFocus
          className="w-full border-b border-neutral-200 px-4 py-3 text-base focus:outline-none"
          placeholder="검색 (제목·본문·태그) — Ctrl+클릭하면 새 창"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />

        <div className="flex flex-wrap items-center gap-1.5 border-b border-neutral-100 px-4 py-2">
          {schemas.map((s) => (
            <button
              key={s.id}
              className={`rounded-full px-2.5 py-0.5 text-xs ${
                types.includes(s.id)
                  ? "bg-neutral-800 text-white"
                  : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
              }`}
              onClick={() => toggleType(s.id)}
            >
              {s.label}
            </button>
          ))}
          <button
            className={`ml-auto rounded-full px-2.5 py-0.5 text-xs ${
              searchFuzzy
                ? "bg-sky-600 text-white"
                : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
            }`}
            title="오타와 초성을 견디는 검색 (ㅋㄹㅋㄷ → 클린 코드). 정확히 맞는 결과가 늘 위에 옵니다."
            onClick={() => toggleSearchFuzzy()}
          >
            ≈ 오타 허용
          </button>
          <select
            className="rounded border border-neutral-300 px-2 py-0.5 text-xs focus:border-neutral-500 focus:outline-none"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {PERIODS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
          {filterCount > 0 && (
            <button
              className="text-xs text-neutral-500 underline hover:text-neutral-800"
              onClick={() => {
                setTypes([]);
                setDays(0);
                setTags([]);
              }}
            >
              초기화
            </button>
          )}
        </div>

        {tagList.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-neutral-100 px-4 py-2">
            <span className="text-2xs text-neutral-400">태그</span>
            {shownTags.map((t) => (
              <button
                key={t}
                className={`rounded-full px-2.5 py-0.5 text-xs ${
                  tags.includes(t)
                    ? "bg-violet-600 text-white"
                    : "bg-violet-50 text-violet-600 hover:bg-violet-100"
                }`}
                onClick={() =>
                  setTags((cur) =>
                    cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t],
                  )
                }
              >
                #{t}
              </button>
            ))}
            {tagList.length > shownTags.length && (
              <button
                className="text-xs text-neutral-500 underline hover:text-neutral-800"
                onClick={() => setAllTagsOpen(true)}
              >
                +{tagList.length - shownTags.length}개 더
              </button>
            )}
          </div>
        )}

        <ul className="max-h-96 overflow-y-auto">
          {hits.map((h, i) => (
            <li key={h.rel_path}>
              <button
                className={`flex w-full items-center gap-3 px-4 py-2 text-left ${
                  i === selected ? "bg-neutral-100" : "hover:bg-neutral-50"
                }`}
                onMouseEnter={() => setSelected(i)}
                onClick={(e) => {
                  // Ctrl+클릭이면 새 창으로 (검색창은 열어 둔다)
                  if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    openNoteWindow(h.rel_path);
                    return;
                  }
                  open(h);
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    openNoteWindow(h.rel_path);
                  }
                }}
              >
                <span className="w-16 shrink-0 self-start rounded bg-neutral-100 px-1.5 py-0.5 text-center text-2xs text-neutral-500">
                  {typeLabel(schemas, h.note_type)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    <Highlight text={h.title} query={query} />
                  </span>
                  {h.snippet && (
                    <span className="mt-0.5 line-clamp-2 block text-xs text-neutral-500">
                      <Highlight text={h.snippet} query={query} />
                    </span>
                  )}
                </span>
                <span className="shrink-0 self-start text-xs text-neutral-400">
                  {h.date}
                </span>
              </button>
            </li>
          ))}
          {query.trim() && hits.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-neutral-400">
              결과가 없습니다
              {filterCount > 0 && (
                <span className="mt-1 block text-xs">
                  필터 {filterCount}개가 걸려 있습니다
                </span>
              )}
            </li>
          )}
        </ul>
    </Modal>
  );
}
