import { useMemo, useState } from "react";
import { useCreateRequest } from "../lib/shortcuts";
import type { NoteSummary } from "../bindings";
import { useVault } from "../stores/vault";
import { fmStr } from "../lib/note";
import NewNoteDialog, { nextEpisodeNumber } from "./NewNoteDialog";

// 글쓰기 전용 상태 라벨 (책 상태와 다름 — 통합하지 않는다)
const STATUS_LABELS: Record<string, string> = {
  idea: "구상",
  draft: "초고",
  revise: "퇴고",
  done: "완성",
};
const STATUS_ORDER = ["draft", "revise", "idea", "done"];
const STATUS_COLORS: Record<string, string> = {
  idea: "bg-neutral-100 text-neutral-600",
  draft: "bg-sky-50 text-sky-700",
  revise: "bg-amber-50 text-amber-700",
  done: "bg-emerald-50 text-emerald-700",
};

/** 쓰기 대시보드: 상태별/분야별 원고 카드 + 연재 시리즈 + 글자수 진행바 */
export default function WritingDashboard() {
  const { notes, openNote } = useVault();
  const [creating, setCreating] = useState(false);

  useCreateRequest(() => setCreating(true));
  const [groupMode, setGroupMode] = useState<"status" | "category">("status");

  const pieces = useMemo(
    () => notes.filter((n) => n.note_type === "writing"),
    [notes],
  );
  const totalChars = useMemo(
    () => pieces.reduce((sum, p) => sum + p.char_count, 0),
    [pieces],
  );

  // 시리즈로 묶인 원고 / 단편 분리
  const [seriesGroups, singles] = useMemo(() => {
    const map = new Map<string, NoteSummary[]>();
    const rest: NoteSummary[] = [];
    for (const p of pieces) {
      const s = fmStr(p, "series");
      if (s) map.set(s, [...(map.get(s) ?? []), p]);
      else rest.push(p);
    }
    // 각 시리즈 내부는 회차 역순
    for (const [k, list] of map) {
      map.set(
        k,
        [...list].sort(
          (a, b) => Number(fmStr(b, "episode")) - Number(fmStr(a, "episode")),
        ),
      );
    }
    return [[...map.entries()], rest] as const;
  }, [pieces]);

  const groups = useMemo(() => {
    const map = new Map<string, NoteSummary[]>();
    if (groupMode === "status") {
      for (const p of singles) {
        const s = fmStr(p, "status") || "idea";
        map.set(s, [...(map.get(s) ?? []), p]);
      }
      return STATUS_ORDER.filter((s) => map.has(s)).map(
        (s) => [STATUS_LABELS[s] ?? s, map.get(s)!] as const,
      );
    }
    for (const p of singles) {
      const c = fmStr(p, "category") || "미분류";
      map.set(c, [...(map.get(c) ?? []), p]);
    }
    return [...map.keys()]
      .sort((a, b) =>
        a === "미분류" ? 1 : b === "미분류" ? -1 : a.localeCompare(b, "ko"),
      )
      .map((k) => [k, map.get(k)!] as const);
  }, [singles, groupMode]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-3">
        <div>
          <h1 className="text-lg font-bold">
            글쓰기{" "}
            <span className="text-sm font-normal text-neutral-400">
              {pieces.length}편
            </span>
          </h1>
          <p className="mt-0.5 text-xs text-neutral-400">
            총 {totalChars.toLocaleString()}자 (공백 제외)
          </p>
        </div>
        <div className="flex items-center gap-1 text-xs">
          {(
            [
              ["status", "상태별"],
              ["category", "분야별"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              className={`rounded px-2.5 py-1 ${
                groupMode === v
                  ? "bg-neutral-200 text-neutral-800"
                  : "text-neutral-400 hover:bg-neutral-100"
              }`}
              onClick={() => setGroupMode(v)}
            >
              {label}
            </button>
          ))}
          <button
            className="ml-2 rounded bg-neutral-800 px-3 py-1.5 text-sm text-white hover:bg-neutral-600"
            onClick={() => setCreating(true)}
          >
            새 글
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {pieces.length === 0 && (
          <p className="mt-16 text-center text-sm text-neutral-400">
            아직 원고가 없습니다. [새 글]로 첫 글을 시작해 보세요. 시리즈명을
            넣으면 '시리즈명 0001편'부터 연재가 시작됩니다.
          </p>
        )}

        {seriesGroups.length > 0 && (
          <section className="mb-6">
            <h2 className="mb-2 text-sm font-semibold text-neutral-600">
              연재 시리즈{" "}
              <span className="font-normal text-neutral-400">
                {seriesGroups.length}
              </span>
            </h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-3">
              {seriesGroups.map(([series, episodes]) => (
                <SeriesCard key={series} series={series} episodes={episodes} />
              ))}
            </div>
          </section>
        )}

        {groups.map(([label, items]) => (
          <section key={label} className="mb-6">
            <h2 className="mb-2 text-sm font-semibold text-neutral-600">
              {label}{" "}
              <span className="font-normal text-neutral-400">
                {items.length}
              </span>
            </h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
              {items.map((p) => (
                <PieceCard key={p.rel_path} piece={p} onOpen={() => openNote(p.rel_path)} />
              ))}
            </div>
          </section>
        ))}
      </div>

      {creating && (
        <NewNoteDialog noteType="writing" onClose={() => setCreating(false)} />
      )}
    </div>
  );
}

/** 연재 시리즈 카드: 편수·누적 글자수 + [다음 편 쓰기] */
function SeriesCard({
  series,
  episodes,
}: {
  series: string;
  episodes: NoteSummary[];
}) {
  const { notes, openNote, createNote } = useVault();
  const [busy, setBusy] = useState(false);
  const totalChars = episodes.reduce((s, e) => s + e.char_count, 0);

  async function nextEpisode() {
    if (busy) return;
    setBusy(true);
    try {
      const ep = nextEpisodeNumber(notes, series);
      const title = `${series} ${String(ep).padStart(4, "0")}편`;
      const category = fmStr(episodes[0], "category");
      const fields: Record<string, string | number> = {
        series,
        episode: ep,
        status: "draft",
      };
      if (category) fields.category = category;
      await createNote("writing", title, fields);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-bold">📜 {series}</span>
        <span className="shrink-0 text-[11px] text-neutral-400">
          {episodes.length}편 · {totalChars.toLocaleString()}자
        </span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {episodes.slice(0, 3).map((e) => (
          <li key={e.rel_path}>
            <button
              className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs text-neutral-600 hover:bg-neutral-50"
              onClick={() => openNote(e.rel_path)}
            >
              <span className="truncate">{e.title}</span>
              <span className="shrink-0 text-[10px] text-neutral-400">
                {e.char_count.toLocaleString()}자
              </span>
            </button>
          </li>
        ))}
        {episodes.length > 3 && (
          <li className="px-2 text-[10px] text-neutral-300">
            외 {episodes.length - 3}편…
          </li>
        )}
      </ul>
      <button
        className="rounded bg-neutral-800 py-1.5 text-xs text-white hover:bg-neutral-600 disabled:opacity-50"
        disabled={busy}
        onClick={nextEpisode}
      >
        {busy ? "만드는 중…" : "+ 다음 편 쓰기"}
      </button>
    </div>
  );
}

function PieceCard({ piece, onOpen }: { piece: NoteSummary; onOpen: () => void }) {
  const status = fmStr(piece, "status") || "idea";
  const category = fmStr(piece, "category");
  const goal = Number(fmStr(piece, "goal")) || 0;
  const progress = goal > 0 ? Math.min(100, (piece.char_count / goal) * 100) : 0;

  return (
    <button
      className="flex flex-col gap-1.5 rounded-lg border border-neutral-200 bg-white p-3 text-left shadow-sm transition-shadow hover:shadow-md"
      onClick={onOpen}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-2 text-sm font-semibold">{piece.title}</span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${STATUS_COLORS[status] ?? STATUS_COLORS.idea}`}
        >
          {STATUS_LABELS[status] ?? status}
        </span>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-neutral-400">
        {category && <span>{category}</span>}
        <span className="ml-auto">
          {piece.char_count.toLocaleString()}자
          {goal > 0 && ` / ${goal.toLocaleString()}자`}
        </span>
      </div>
      {goal > 0 && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
          <div
            className={`h-full rounded-full ${progress >= 100 ? "bg-emerald-500" : "bg-sky-500"}`}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
      <span className="text-[10px] text-neutral-300">{piece.date}</span>
    </button>
  );
}
