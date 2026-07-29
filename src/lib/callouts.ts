// 콜아웃 종류 정의 — 입력 바·기록 카드·원문 변환 메뉴가 모두 여기를 본다.
// (livePreview의 본문 렌더 색은 CSS 클래스라 editor/livePreview.ts에 따로 있다)

/** 커스텀 콜아웃도 고를 수 있는 고정 팔레트 */
export type PaletteColor =
  | "amber"
  | "orange"
  | "yellow"
  | "lime"
  | "emerald"
  | "teal"
  | "sky"
  | "blue"
  | "indigo"
  | "violet"
  | "fuchsia"
  | "rose"
  | "stone"
  | "red"
  | "black"
  | "neutral";

export interface CalloutKind {
  label: string;
  icon: string;
  color: PaletteColor;
}

/** Tailwind는 클래스 이름을 정적으로 써야 해서 색마다 미리 적어 둔다 */
const STYLES: Record<
  PaletteColor,
  { card: string; active: string; idle: string; bar: string }
> = {
  amber: {
    card: "border-amber-200 bg-amber-50 text-amber-800",
    active: "bg-amber-500 text-white",
    idle: "bg-white text-amber-700 hover:bg-amber-100",
    bar: "bg-amber-50 border-amber-200",
  },
  sky: {
    card: "border-sky-200 bg-sky-50 text-sky-800",
    active: "bg-sky-500 text-white",
    idle: "bg-white text-sky-700 hover:bg-sky-100",
    bar: "bg-sky-50 border-sky-200",
  },
  emerald: {
    card: "border-emerald-200 bg-emerald-50 text-emerald-800",
    active: "bg-emerald-500 text-white",
    idle: "bg-white text-emerald-700 hover:bg-emerald-100",
    bar: "bg-emerald-50 border-emerald-200",
  },
  violet: {
    card: "border-violet-200 bg-violet-50 text-violet-800",
    active: "bg-violet-500 text-white",
    idle: "bg-white text-violet-700 hover:bg-violet-100",
    bar: "bg-violet-50 border-violet-200",
  },
  rose: {
    card: "border-rose-200 bg-rose-50 text-rose-800",
    active: "bg-rose-500 text-white",
    idle: "bg-white text-rose-700 hover:bg-rose-100",
    bar: "bg-rose-50 border-rose-200",
  },
  orange: {
    card: "border-orange-200 bg-orange-50 text-orange-800",
    active: "bg-orange-500 text-white",
    idle: "bg-white text-orange-700 hover:bg-orange-100",
    bar: "bg-orange-50 border-orange-200",
  },
  yellow: {
    card: "border-yellow-200 bg-yellow-50 text-yellow-800",
    active: "bg-yellow-500 text-white",
    idle: "bg-white text-yellow-700 hover:bg-yellow-100",
    bar: "bg-yellow-50 border-yellow-200",
  },
  lime: {
    card: "border-lime-200 bg-lime-50 text-lime-800",
    active: "bg-lime-500 text-white",
    idle: "bg-white text-lime-700 hover:bg-lime-100",
    bar: "bg-lime-50 border-lime-200",
  },
  teal: {
    card: "border-teal-200 bg-teal-50 text-teal-800",
    active: "bg-teal-500 text-white",
    idle: "bg-white text-teal-700 hover:bg-teal-100",
    bar: "bg-teal-50 border-teal-200",
  },
  blue: {
    card: "border-blue-200 bg-blue-50 text-blue-800",
    active: "bg-blue-500 text-white",
    idle: "bg-white text-blue-700 hover:bg-blue-100",
    bar: "bg-blue-50 border-blue-200",
  },
  indigo: {
    card: "border-indigo-200 bg-indigo-50 text-indigo-800",
    active: "bg-indigo-500 text-white",
    idle: "bg-white text-indigo-700 hover:bg-indigo-100",
    bar: "bg-indigo-50 border-indigo-200",
  },
  fuchsia: {
    card: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-800",
    active: "bg-fuchsia-500 text-white",
    idle: "bg-white text-fuchsia-700 hover:bg-fuchsia-100",
    bar: "bg-fuchsia-50 border-fuchsia-200",
  },
  stone: {
    card: "border-stone-300 bg-stone-100 text-stone-700",
    active: "bg-stone-500 text-white",
    idle: "bg-white text-stone-600 hover:bg-stone-100",
    bar: "bg-stone-50 border-stone-200",
  },
  red: {
    card: "border-red-200 bg-red-50 text-red-800",
    active: "bg-red-500 text-white",
    idle: "bg-white text-red-700 hover:bg-red-100",
    bar: "bg-red-50 border-red-200",
  },
  black: {
    card: "border-neutral-700 bg-neutral-200 text-neutral-900",
    active: "bg-neutral-900 text-white",
    idle: "bg-white text-neutral-900 hover:bg-neutral-200",
    bar: "bg-neutral-100 border-neutral-300",
  },
  neutral: {
    card: "border-neutral-200 bg-neutral-50 text-neutral-700",
    active: "bg-neutral-600 text-white",
    idle: "bg-white text-neutral-600 hover:bg-neutral-100",
    bar: "bg-neutral-50 border-neutral-200",
  },
};

export function styleOf(color: PaletteColor) {
  return STYLES[color] ?? STYLES.neutral;
}

/** 독서기록 기본 종류 */
export const BOOK_KINDS: CalloutKind[] = [
  { label: "발췌", icon: "📌", color: "amber" },
  { label: "생각", icon: "💭", color: "sky" },
  { label: "요약", icon: "📋", color: "emerald" },
  { label: "질문", icon: "❓", color: "violet" },
];

/** 일지 기본 콜아웃 종류 (할 일은 체크박스라 콜아웃이 아니다) */
export const DAILY_KINDS: CalloutKind[] = [
  { label: "기록", icon: "🕘", color: "sky" },
  { label: "느낌", icon: "💛", color: "amber" },
];

const FALLBACK: CalloutKind = { label: "", icon: "💬", color: "neutral" };

/** 이름으로 종류 찾기 — 모르는 이름(외부 편집기에서 넣은 것)은 기본값 */
export function kindByLabel(
  label: string,
  extra: CalloutKind[] = [],
): CalloutKind {
  return (
    [...BOOK_KINDS, ...DAILY_KINDS, ...extra].find((k) => k.label === label) ?? {
      ...FALLBACK,
      label,
    }
  );
}
