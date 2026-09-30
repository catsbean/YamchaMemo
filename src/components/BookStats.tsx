import { useMemo, useState } from "react";
import type { NoteSummary } from "../bindings";
import { GENRE_NONE, readingStats } from "../lib/readingStats";

/** 세로 막대 — 해별·월별. 막대 위에 수, 아래에 이름. 0인 칸도 자리는 지킨다. */
function Columns({
  items,
  selected,
  onPick,
}: {
  items: { key: string; label: string; count: number }[];
  selected?: string | null;
  onPick?: (key: string) => void;
}) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="flex h-36 items-end gap-1.5">
      {items.map((i) => {
        const on = selected === i.key;
        const bar = (
          <>
            <span className="mb-0.5 text-2xs text-neutral-500 tabular-nums">
              {i.count > 0 ? i.count : ""}
            </span>
            <span
              className={`w-full rounded-t ${
                i.count === 0 ? "bg-neutral-200" : on ? "bg-sky-600" : "bg-sky-400/80"
              }`}
              style={{ height: `${Math.max(i.count === 0 ? 2 : 6, (i.count / max) * 100)}px` }}
            />
            <span
              className={`mt-1 text-2xs tabular-nums ${on ? "font-semibold text-neutral-800" : "text-neutral-400"}`}
            >
              {i.label}
            </span>
          </>
        );
        return onPick ? (
          <button
            key={i.key}
            type="button"
            className="flex min-w-0 flex-1 flex-col items-center justify-end rounded hover:bg-neutral-50"
            onClick={() => onPick(i.key)}
            title={`${i.label} — ${i.count}권`}
          >
            {bar}
          </button>
        ) : (
          <div
            key={i.key}
            className="flex min-w-0 flex-1 flex-col items-center justify-end"
            title={`${i.label} — ${i.count}권`}
          >
            {bar}
          </div>
        );
      })}
    </div>
  );
}

/** 가로 막대 — 분야·평점. 이름, 막대, 수(와 비율). */
function Rows({
  items,
  total,
}: {
  items: { label: string; count: number; muted?: boolean }[];
  total: number;
}) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-2 text-xs">
          <span
            className={`w-24 shrink-0 truncate ${i.muted ? "text-neutral-400" : "text-neutral-600"}`}
            title={i.label}
          >
            {i.label}
          </span>
          <span className="h-3 min-w-0 flex-1 overflow-hidden rounded bg-neutral-100">
            <span
              className={`block h-full rounded ${i.muted ? "bg-neutral-300" : "bg-amber-400"}`}
              style={{ width: `${(i.count / max) * 100}%` }}
            />
          </span>
          <span className="w-16 shrink-0 text-right text-neutral-500 tabular-nums">
            {i.count}권
            {total > 0 && (
              <span className="ml-1 text-2xs text-neutral-400">
                {Math.round((i.count / total) * 100)}%
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-neutral-600">{title}</h2>
      {children}
    </section>
  );
}

/** 책장의 [통계] — 해마다 몇 권, 올해는 달마다, 어떤 분야를, 몇 점으로.
 *
 *  그림은 CSS 막대로만 그린다(무게 규율 — 차트 라이브러리를 들이지 않는다). 숫자 규칙은
 *  `readingStats`가 전부 갖고 있고, 홈의 "올해 N권"도 같은 규칙을 쓴다. */
export default function BookStats({ books }: { books: NoteSummary[] }) {
  const thisYear = String(new Date().getFullYear());
  const all = useMemo(() => readingStats(books, null), [books]);
  // 올해 읽은 책이 있으면 올해부터, 없으면 전체 기간부터 보여 준다
  const [year, setYear] = useState<string | null>(() =>
    all.byYear.some((y) => y.year === thisYear && y.count > 0) ? thisYear : null,
  );
  const s = useMemo(() => (year ? readingStats(books, year) : all), [books, year, all]);

  if (all.finished === 0) {
    return (
      <p className="mt-16 px-6 text-center text-sm text-neutral-400">
        완독한 책이 아직 없습니다. 책의 상태를 ‘완독’으로 바꾸면 여기에 쌓입니다.
      </p>
    );
  }

  const chip = (on: boolean) =>
    `rounded px-2.5 py-1 text-xs ${
      on ? "bg-neutral-800 text-white" : "text-neutral-500 hover:bg-neutral-100"
    }`;

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-1">
        <button type="button" className={chip(year === null)} onClick={() => setYear(null)}>
          전체
        </button>
        {[...all.byYear].reverse().map((y) => (
          <button
            key={y.year}
            type="button"
            className={chip(year === y.year)}
            onClick={() => setYear(y.year)}
          >
            {y.year}
          </button>
        ))}
      </div>

      <p className="mb-4 text-sm text-neutral-700">
        <b className="text-base">{year ? `${year}년` : "지금까지"}</b> 완독{" "}
        <b className="text-base tabular-nums">{s.finished}</b>권
        {s.average != null && (
          <span className="ml-2 text-neutral-500">
            · 평균 <span className="text-amber-500">★</span>
            {s.average.toFixed(1)}
          </span>
        )}
        {s.undated > 0 && (
          <span className="mt-0.5 block text-2xs text-neutral-400">
            완독일이 비어 있는 {s.undated}권은 노트 날짜로 셉니다.
          </span>
        )}
      </p>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="해마다 읽은 책">
          <Columns
            items={all.byYear.map((y) => ({ key: y.year, label: y.year.slice(2) + "년", count: y.count }))}
            selected={year}
            onPick={(k) => setYear(k === year ? null : k)}
          />
        </Card>
        {year && (
          <Card title={`${year}년 달마다`}>
            <Columns
              items={s.byMonth.map((m) => ({ key: String(m.month), label: `${m.month}`, count: m.count }))}
            />
          </Card>
        )}
        <Card title="분야">
          <Rows
            items={s.genres.map((g) => ({
              label: g.genre,
              count: g.count,
              muted: g.genre === GENRE_NONE,
            }))}
            total={s.finished}
          />
        </Card>
        <Card title="평점">
          <Rows
            items={[
              ...[...s.ratings].reverse().map((r) => ({
                label: "★".repeat(r.stars),
                count: r.count,
              })),
              ...(s.unrated > 0 ? [{ label: "평점 없음", count: s.unrated, muted: true }] : []),
            ]}
            total={s.finished}
          />
        </Card>
      </div>
    </div>
  );
}
