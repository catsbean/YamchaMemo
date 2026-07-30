import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { commands, type FileIndexStatus, type SearchHit } from "../bindings";
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

/** `file-index-progress` 이벤트 payload.
 *  커맨드 반환 타입이 아니라 이벤트라서 bindings에 생성되지 않는다
 *  (EnrichDialog의 Progress와 같은 관례). */
type FileIndexProgress = { done: number; total: number; current: string };

/** 켜고 끄는 것임이 한눈에 보이는 스위치.
 *  칩(필터)과 구분되어야 해서 손잡이가 움직이는 트랙을 단다. */
function Switch({
  on,
  label,
  title,
  color,
  onClick,
}: {
  on: boolean;
  label: string;
  title: string;
  color: "sky" | "emerald";
  onClick: () => void;
}) {
  const onBg = color === "sky" ? "bg-sky-600" : "bg-emerald-600";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={title}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors ${
        on
          ? `border-transparent ${onBg} text-white`
          : "border-neutral-300 text-neutral-600 hover:bg-neutral-100"
      }`}
    >
      <span
        className={`relative inline-block h-3 w-6 shrink-0 rounded-full transition-colors ${
          on ? "bg-white/40" : "bg-neutral-300"
        }`}
      >
        <span
          className={`absolute top-0.5 h-2 w-2 rounded-full bg-white transition-all ${
            on ? "left-3.5" : "left-0.5"
          }`}
        />
      </span>
      {label}
    </button>
  );
}

/** 파일 이름에서 확장자 배지 문자열 */
function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toUpperCase() : "파일";
}

/** vault 상대경로 → 절대경로 (열기·폴더에서 보기) */
async function filePath(rel: string): Promise<string | null> {
  const r = await commands.getVaultPath();
  if (!r) return null;
  return `${r}/${rel}`;
}

/** 안 잡히는 문서를 사용자에게 설명한다 (스캔본·암호·실패) */
function gapNote(s: FileIndexStatus): string {
  const parts: string[] = [];
  if (s.empty > 0) parts.push(`텍스트가 없는 문서 ${s.empty}개(스캔본)`);
  if (s.encrypted > 0) parts.push(`암호 걸린 문서 ${s.encrypted}개`);
  if (s.failed > 0) parts.push(`읽지 못한 문서 ${s.failed}개`);
  if (s.too_big > 0) parts.push(`너무 큰 문서 ${s.too_big}개`);
  return parts.length > 0 ? `${parts.join(" · ")}는 검색되지 않습니다` : "";
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
  const searchInFiles = useVault((s) => s.searchInFiles);
  const toggleSearchInFiles = useVault((s) => s.toggleSearchInFiles);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [fileHits, setFileHits] = useState<SearchHit[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [progress, setProgress] = useState<FileIndexProgress | null>(null);
  const [fileStatus, setFileStatus] = useState<FileIndexStatus | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const seqRef = useRef(0);
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
      // 요청 일련번호 — 타이핑이 이어지면 응답 순서가 뒤집힐 수 있다
      const seq = ++seqRef.current;

      // 1단계: 노트. 여기까지가 첫 화면이고, 첨부가 몇 개든 이 시간은 안 늘어난다.
      const r = await commands.search(query, {
        types,
        days,
        tags,
        scope: "Notes",
        fuzzy: searchFuzzy,
      });
      if (seq !== seqRef.current) return;
      if (r.status === "ok") {
        setHits(r.data);
        setSelected(0);
      }

      // 2단계: 첨부 문서. 노트 결과를 이미 그린 뒤에 뒤에 붙인다.
      if (!searchInFiles) {
        // 토글을 끄면 지난 결과를 비운다 — 남겨 두면 "결과가 없습니다"가 가려진다
        setFileHits([]);
        return;
      }
      setFilesLoading(true);
      const f = await commands.search(query, {
        types,
        days,
        tags,
        scope: "Files",
        fuzzy: searchFuzzy,
      });
      if (seq !== seqRef.current) return;
      setFilesLoading(false);
      if (f.status === "ok") setFileHits(f.data);
    }, 150);
    return () => clearTimeout(t);
  }, [query, types, days, tags, searchFuzzy, searchInFiles]);

  // 첨부 색인 진행 상황 (처음 켤 때만 눈에 띈다)
  useEffect(() => {
    const unlisten = [
      listen<FileIndexProgress>("file-index-progress", (e) => setProgress(e.payload)),
      listen<FileIndexStatus>("file-index-done", (e) => {
        setProgress(null);
        setFileStatus(e.payload);
        // 색인이 끝났으니 지금 쿼리로 다시 물어본다
        setRefreshTick((n) => n + 1);
      }),
    ];
    commands.fileIndexStatus().then((r) => {
      if (r.status === "ok") setFileStatus(r.data);
    });
    return () => {
      unlisten.forEach((p) => p.then((f) => f()));
    };
  }, []);

  // 색인이 끝난 뒤 첨부 결과만 다시 받는다
  useEffect(() => {
    if (!searchInFiles || !query.trim() || refreshTick === 0) return;
    (async () => {
      const f = await commands.search(query, {
        types,
        days,
        tags,
        scope: "Files",
        fuzzy: searchFuzzy,
      });
      if (f.status === "ok") setFileHits(f.data);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

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
          {filterCount > 0 && (
            <button
              className="ml-auto text-xs text-neutral-500 underline hover:text-neutral-800"
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

        {/* 검색 방식 — 분류 칩(필터)과 줄을 나눠 성격이 다름을 드러낸다 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-neutral-100 px-4 py-2">
          <Switch
            on={searchFuzzy}
            label="오타 허용"
            color="sky"
            title="오타와 초성을 견디는 검색 (ㄱㅇㅁ → 구운몽). 정확히 맞는 결과가 늘 위에 옵니다."
            onClick={() => toggleSearchFuzzy()}
          />
          <Switch
            on={searchInFiles}
            label="첨부내용검색"
            color="emerald"
            title="첨부한 pdf·hwp·오피스 문서의 본문까지 찾습니다. 처음 켤 때 문서를 한 번 읽습니다."
            onClick={() => toggleSearchInFiles()}
          />
          <select
            className="ml-auto rounded border border-neutral-300 px-2 py-0.5 text-xs focus:border-neutral-500 focus:outline-none"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {PERIODS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
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
          {query.trim() && hits.length === 0 && fileHits.length === 0 && !filesLoading && (
            <li className="px-4 py-6 text-center text-sm text-neutral-400">
              결과가 없습니다
              {filterCount > 0 && (
                <span className="mt-1 block text-xs">
                  필터 {filterCount}개가 걸려 있습니다
                </span>
              )}
            </li>
          )}

          {/* 2단계 — 첨부 문서. 노트 결과 뒤에 붙는다 */}
          {searchInFiles && query.trim() && (
            <>
              <li className="flex items-center gap-2 border-t border-neutral-100 bg-neutral-50 px-4 py-1.5 text-2xs text-neutral-500">
                <span>문서 속</span>
                {filesLoading && <span className="text-neutral-400">찾는 중…</span>}
                {progress && (
                  <span className="text-neutral-400">
                    문서 읽는 중 {progress.done}/{progress.total} — {progress.current}
                  </span>
                )}
                {!filesLoading && !progress && fileHits.length === 0 && (
                  <span className="text-neutral-400">해당 문서 없음</span>
                )}
              </li>
              {fileHits.map((h) => (
                <li key={h.rel_path}>
                  <button
                    className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-neutral-50"
                    title={`${h.rel_path} — 클릭하면 기본 앱으로, Ctrl+클릭하면 폴더에서 보기`}
                    onClick={async (e) => {
                      const abs = await filePath(h.rel_path);
                      if (!abs) return;
                      if (e.ctrlKey || e.metaKey) await revealItemInDir(abs);
                      else await openPath(abs);
                    }}
                  >
                    <span className="w-16 shrink-0 self-start rounded bg-emerald-50 px-1.5 py-0.5 text-center text-2xs text-emerald-700">
                      {extOf(h.title)}
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
              {/* 안 잡히는 문서가 있으면 이유를 알려 준다 — 없으면 "검색이 안 된다"로 오해한다 */}
              {fileStatus && gapNote(fileStatus) && (
                <li className="px-4 py-2 text-2xs text-neutral-400">{gapNote(fileStatus)}</li>
              )}
            </>
          )}
        </ul>
    </Modal>
  );
}
