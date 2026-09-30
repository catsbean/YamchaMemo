import type { NoteSummary } from "../bindings";
import { fmStr } from "./note";

/** 독서 통계 (7-4) — 책장의 [통계]와 홈의 "올해 N권"이 **같은 규칙**을 쓴다.
 *
 *  완독한 책은 `status: finished`인 책이다. 언제 읽었는지는 `finished`(완독일)를 보고,
 *  비어 있으면 노트 날짜(`date` — 파일명이 날짜가 아니면 수정시각)로 센다. 홈이 원래 그렇게
 *  셌다 — 규칙이 둘이면 홈과 통계의 "올해"가 어긋난다. */

/** 완독한 책이면 그 날짜(`YYYY-MM-DD` 또는 그 앞부분), 아니면 "" */
export function finishedDateOf(book: NoteSummary): string {
  if (fmStr(book, "status") !== "finished") return "";
  return fmStr(book, "finished").trim() || book.date;
}

/** 이 해(`"2026"`)에 완독한 책 */
export function finishedIn(books: NoteSummary[], year: string): NoteSummary[] {
  return books.filter((b) => finishedDateOf(b).startsWith(year));
}

export const GENRE_NONE = "분야 없음";

export type ReadingStats = {
  /** 완독한 해들 — 오래된 해부터, 사이에 빈 해도 0으로 넣는다 (막대가 건너뛰지 않게) */
  byYear: { year: string; count: number }[];
  /** 고른 해의 월별 완독 수 (1~12월). 해를 안 골랐으면 빈 배열 */
  byMonth: { month: number; count: number }[];
  /** 고른 범위에서 완독한 책의 분야 — 많은 것부터, 분야가 없으면 `GENRE_NONE` */
  genres: { genre: string; count: number }[];
  /** 고른 범위에서 완독한 책의 평점 분포 (1~5점, 반올림). 평점이 없으면 `unrated`로 */
  ratings: { stars: number; count: number }[];
  unrated: number;
  /** 평점이 있는 책의 평균 (없으면 null) */
  average: number | null;
  /** 고른 범위의 완독 수 */
  finished: number;
  /** 그중 완독일이 없어 노트 날짜로 센 책 */
  undated: number;
};

/** `year`가 null이면 전체 기간 */
export function readingStats(books: NoteSummary[], year: string | null): ReadingStats {
  const done = books
    .map((b) => ({ b, date: finishedDateOf(b) }))
    .filter((x) => /^\d{4}/.test(x.date));

  const perYear = new Map<string, number>();
  for (const { date } of done) {
    const y = date.slice(0, 4);
    perYear.set(y, (perYear.get(y) ?? 0) + 1);
  }
  const years = [...perYear.keys()].map(Number).sort((a, b) => a - b);
  const byYear: ReadingStats["byYear"] = [];
  if (years.length > 0) {
    for (let y = years[0]; y <= years[years.length - 1]; y++) {
      byYear.push({ year: String(y), count: perYear.get(String(y)) ?? 0 });
    }
  }

  const scope = year ? done.filter((x) => x.date.startsWith(year)) : done;

  const byMonth: ReadingStats["byMonth"] = [];
  if (year) {
    for (let m = 1; m <= 12; m++) byMonth.push({ month: m, count: 0 });
    for (const { date } of scope) {
      const m = Number(date.slice(5, 7));
      // 완독일이 "2026"처럼 해만 적혀 있으면 달 막대에는 넣지 않는다
      if (m >= 1 && m <= 12) byMonth[m - 1].count += 1;
    }
  }

  const perGenre = new Map<string, number>();
  for (const { b } of scope) {
    const g = fmStr(b, "genre").trim() || GENRE_NONE;
    perGenre.set(g, (perGenre.get(g) ?? 0) + 1);
  }
  const genres = [...perGenre.entries()]
    .map(([genre, count]) => ({ genre, count }))
    .sort((a, b) => {
      // 분야 없음은 맨 뒤 — 수가 많아도 "가장 많이 읽은 분야"처럼 보이면 안 된다
      if (a.genre === GENRE_NONE) return 1;
      if (b.genre === GENRE_NONE) return -1;
      return b.count - a.count || a.genre.localeCompare(b.genre, "ko");
    });

  const ratings = [1, 2, 3, 4, 5].map((stars) => ({ stars, count: 0 }));
  let unrated = 0;
  let sum = 0;
  let rated = 0;
  for (const { b } of scope) {
    const r = Number(fmStr(b, "rating"));
    if (!fmStr(b, "rating").trim() || !Number.isFinite(r) || r <= 0) {
      unrated += 1;
      continue;
    }
    const stars = Math.min(5, Math.max(1, Math.round(r)));
    ratings[stars - 1].count += 1;
    sum += r;
    rated += 1;
  }

  return {
    byYear,
    byMonth,
    genres,
    ratings,
    unrated,
    average: rated > 0 ? sum / rated : null,
    finished: scope.length,
    undated: scope.filter(({ b }) => !fmStr(b, "finished").trim()).length,
  };
}
