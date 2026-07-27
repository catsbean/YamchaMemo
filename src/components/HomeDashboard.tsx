import { useMemo } from "react";
import { typeLabel, useVault } from "../stores/vault";
import { fmStr } from "../lib/note";

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 홈: 독서·쓰기 통계 + 데일리 히트맵 + 최근 활동 */
export default function HomeDashboard() {
  const { notes, schemas, openNote, openToday, setNav } = useVault();
  const year = new Date().getFullYear();

  const stats = useMemo(() => {
    const books = notes.filter((n) => n.note_type === "book");
    const readingNow = books.filter((b) => fmStr(b, "status") === "reading");
    const finishedThisYear = books.filter(
      (b) =>
        fmStr(b, "status") === "finished" &&
        (fmStr(b, "finished").startsWith(String(year)) ||
          (!fmStr(b, "finished") && b.date.startsWith(String(year)))),
    );
    const wishlist = books.filter((b) => fmStr(b, "status") === "wishlist");

    const pieces = notes.filter((n) => n.note_type === "writing");
    const inProgress = pieces.filter((p) =>
      ["draft", "revise"].includes(fmStr(p, "status")),
    );
    const doneCount = pieces.filter((p) => fmStr(p, "status") === "done").length;
    const totalChars = pieces.reduce((s, p) => s + p.char_count, 0);

    return {
      bookTotal: books.length,
      readingNow,
      finishedThisYear: finishedThisYear.length,
      wishlist: wishlist.length,
      pieces: pieces.length,
      inProgress,
      doneCount,
      totalChars,
    };
  }, [notes, year]);

  // 데일리 히트맵: 최근 16주 (일요일 시작 열 단위)
  const heatmap = useMemo(() => {
    const dailyDates = new Set(
      notes.filter((n) => n.note_type === "daily").map((n) => n.date),
    );
    const today = new Date();
    const cells: { date: string; has: boolean }[] = [];
    const start = new Date(today);
    start.setDate(start.getDate() - (16 * 7 - 1) - today.getDay());
    for (let i = 0; i < 16 * 7 + today.getDay() + 1; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      if (d > today) break;
      const iso = isoDate(d);
      cells.push({ date: iso, has: dailyDates.has(iso) });
    }
    return cells;
  }, [notes]);

  const streak = useMemo(() => {
    const dailyDates = new Set(
      notes.filter((n) => n.note_type === "daily").map((n) => n.date),
    );
    let count = 0;
    const d = new Date();
    // 오늘 안 썼으면 어제부터 계산
    if (!dailyDates.has(isoDate(d))) d.setDate(d.getDate() - 1);
    while (dailyDates.has(isoDate(d))) {
      count += 1;
      d.setDate(d.getDate() - 1);
    }
    return count;
  }, [notes]);

  const recent = useMemo(() => notes.slice(0, 8), [notes]);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b border-neutral-200 px-6 py-3">
        <h1 className="text-lg font-bold">홈</h1>
      </header>

      <div className="grid gap-4 p-6 lg:grid-cols-2">
        {/* 독서 카드 */}
        <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold">📚 독서</h2>
            <button
              className="text-xs text-neutral-400 hover:text-neutral-600"
              onClick={() => setNav("book")}
            >
              책장 열기 →
            </button>
          </div>
          <div className="mb-3 grid grid-cols-3 gap-2 text-center">
            <Stat label={`${year}년 완독`} value={stats.finishedThisYear} />
            <Stat label="읽는 중" value={stats.readingNow.length} />
            <Stat label="읽고 싶은 책" value={stats.wishlist} />
          </div>
          {stats.readingNow.length > 0 && (
            <ul className="flex flex-col gap-1">
              {stats.readingNow.slice(0, 4).map((b) => (
                <li key={b.rel_path}>
                  <button
                    className="w-full truncate rounded px-2 py-1 text-left text-xs text-neutral-600 hover:bg-neutral-50"
                    onClick={() => openNote(b.rel_path)}
                  >
                    📖 {b.title}
                    {fmStr(b, "author") && (
                      <span className="text-neutral-400"> · {fmStr(b, "author")}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 쓰기 카드 */}
        <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold">✍️ 쓰기</h2>
            <button
              className="text-xs text-neutral-400 hover:text-neutral-600"
              onClick={() => setNav("writing")}
            >
              글쓰기 열기 →
            </button>
          </div>
          <div className="mb-3 grid grid-cols-3 gap-2 text-center">
            <Stat label="전체 원고" value={stats.pieces} />
            <Stat label="완성" value={stats.doneCount} />
            <Stat
              label="총 글자수"
              value={stats.totalChars.toLocaleString()}
              small
            />
          </div>
          {stats.inProgress.length > 0 && (
            <ul className="flex flex-col gap-1">
              {stats.inProgress.slice(0, 4).map((p) => (
                <li key={p.rel_path}>
                  <button
                    className="w-full truncate rounded px-2 py-1 text-left text-xs text-neutral-600 hover:bg-neutral-50"
                    onClick={() => openNote(p.rel_path)}
                  >
                    ✏️ {p.title}
                    <span className="text-neutral-400">
                      {" "}
                      · {p.char_count.toLocaleString()}자
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 데일리 히트맵 */}
        <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold">
              📅 데일리{" "}
              {streak > 0 && (
                <span className="ml-1 text-xs font-normal text-amber-600">
                  🔥 {streak}일 연속
                </span>
              )}
            </h2>
            <button
              className="rounded bg-neutral-800 px-2.5 py-1 text-xs text-white hover:bg-neutral-600"
              onClick={openToday}
            >
              오늘 쓰기
            </button>
          </div>
          <div className="grid grid-flow-col grid-rows-7 gap-[3px]">
            {heatmap.map((c) => (
              <div
                key={c.date}
                title={c.date}
                className={`h-3 w-3 rounded-[3px] ${
                  c.has ? "bg-emerald-500" : "bg-neutral-100"
                }`}
              />
            ))}
          </div>
          <p className="mt-2 text-[10px] text-neutral-400">최근 16주</p>
        </section>

        {/* 최근 활동 */}
        <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-bold">🕘 최근 노트</h2>
          <ul className="flex flex-col gap-0.5">
            {recent.map((n) => (
              <li key={n.rel_path}>
                <button
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-neutral-50"
                  onClick={() => openNote(n.rel_path)}
                >
                  <span className="w-16 shrink-0 rounded bg-neutral-100 px-1 py-0.5 text-center text-[10px] text-neutral-500">
                    {typeLabel(schemas, n.note_type)}
                  </span>
                  <span className="truncate text-neutral-700">{n.title}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-neutral-400">
                    {n.date}
                  </span>
                </button>
              </li>
            ))}
            {recent.length === 0 && (
              <p className="py-4 text-center text-xs text-neutral-400">
                아직 노트가 없습니다
              </p>
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  small = false,
}: {
  label: string;
  value: number | string;
  small?: boolean;
}) {
  return (
    <div className="rounded-lg bg-neutral-50 py-2">
      <p className={`font-bold ${small ? "text-sm" : "text-xl"}`}>{value}</p>
      <p className="text-[10px] text-neutral-400">{label}</p>
    </div>
  );
}
