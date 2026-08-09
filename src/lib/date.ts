// 날짜를 다루는 자잘한 것들. 앱은 날짜를 `YYYY-MM-DD` **문자열**로 들고 다닌다
// (파일 이름·frontmatter·콜아웃 헤더가 전부 그 꼴이다). 고정폭이라 크기 비교가
// 사전순 비교와 같아서, 기간 안팎을 가릴 때 Date로 되돌릴 일이 없다.

export const WEEK = ["일", "월", "화", "수", "목", "금", "토"];

export const pad = (n: number) => String(n).padStart(2, "0");

export const ymd = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** `Daily/2026/07/2026-07-30.md` → `2026-07-30` */
export const dateOf = (relPath: string) =>
  relPath.split("/").pop()?.replace(/\.md$/, "") ?? "";

/** 요일 번호 (0=일 … 6=토). 날짜꼴이 아니면 -1 */
export function weekdayIndex(date: string): number {
  if (!isYmd(date)) return -1;
  return new Date(`${date}T00:00:00`).getDay();
}

/** 요일 한 글자 (`월`). 날짜꼴이 아니면 빈 문자열 */
export function weekdayOf(date: string): string {
  const i = weekdayIndex(date);
  return i < 0 ? "" : WEEK[i];
}

/** n일 뒤(음수면 앞). 달·해를 넘어가는 계산은 Date에 맡긴다 */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** from~to가 며칠인지 — **양끝을 포함**한다 (같은 날이면 1) */
export function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  return Math.floor((b - a) / 86_400_000) + 1;
}
