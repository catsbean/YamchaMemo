// 목록 묶어 보기 (7-6) — 자유노트·사용자 분류·일지 목록이 같은 규칙으로 묶는다.
//
// 정렬(`sort.ts`)과 짝이다. 정렬은 줄의 차례를, 묶기는 그 줄을 어느 칸에 넣을지를 정한다.
// 묶어도 칸 안의 차례는 정렬이 정한 그대로다 — 그래서 여기는 이미 정렬된 목록을 받는다.
import type { FieldDef, NoteSummary } from "../bindings";

/** 고를 수 있는 묶기 하나. `key`는 `none`·`month`이거나 frontmatter 칸 이름이다. */
export type GroupOption = {
  key: string;
  label: string;
  /** select 칸처럼 정해진 차례가 있으면 칸도 그 순서로 (없으면 가나다) */
  order?: string[];
  /** 날짜 칸 — 날짜 하나하나가 아니라 달로 묶는다 */
  byMonth?: boolean;
};

export const NO_GROUP: GroupOption = { key: "none", label: "없음" };
export const MONTH_GROUP: GroupOption = { key: "month", label: "월별" };
/** 값이 없는 노트가 모이는 칸 — 늘 맨 뒤 */
export const UNGROUPED = "미분류";

/** 처음 여는 분류의 묶기 — 일지는 원래 월별로 묶여 있었다 */
export function defaultGroup(noteType: string): string {
  return noteType === "daily" ? "month" : "none";
}

/** 이 분류에서 고를 수 있는 묶기 — 없음·월별에 더해 고르는 칸(select)과 목록에 보이기로 켠 칸.
 *  정렬 후보와 같은 잣대다. 화면에 안 보이는 칸으로 묶으면 왜 그 칸에 있는지 알 수 없다.
 *  태그·별칭은 뺀다(태그는 위의 칩이 이미 거른다), 그림·주소 칸도 뺀다(묶을 값이 아니다). */
export function groupOptions(fields: readonly FieldDef[]): GroupOption[] {
  const out: GroupOption[] = [NO_GROUP, MONTH_GROUP];
  const skip = new Set(["date", "title", "tags", "aliases"]);
  for (const f of fields) {
    if (skip.has(f.name) || f.kind === "image" || f.kind === "url") continue;
    if (!(f.kind === "select" || f.in_list)) continue;
    skip.add(f.name);
    out.push({
      key: f.name,
      label: f.label,
      order: f.kind === "select" && f.options.length > 0 ? f.options : undefined,
      byMonth: f.kind === "date",
    });
  }
  return out;
}

/** 저장된 값이 없어진 칸을 가리키면 그 분류의 기본으로 되돌린다 */
export function normalizeGroup(
  saved: unknown,
  options: readonly GroupOption[],
  noteType: string,
): string {
  if (typeof saved === "string" && options.some((o) => o.key === saved)) return saved;
  return defaultGroup(noteType);
}

/** 한 노트가 들어갈 칸 이름들 — 여러 값을 가진 칸(참석자 등)이면 칸마다 한 번씩 들어간다 */
function keysOf(note: NoteSummary, opt: GroupOption): string[] {
  if (opt.key === "month") return [note.date.slice(0, 7)].filter(Boolean);
  const fm = note.frontmatter as Record<string, unknown> | null;
  const raw = fm && typeof fm === "object" ? fm[opt.key] : undefined;
  const values = (Array.isArray(raw) ? raw : [raw])
    .map((v) =>
      typeof v === "string"
        ? v.replace(/^\[\[|\]\]$/g, "").trim()
        : typeof v === "number"
          ? String(v)
          : "",
    )
    .filter(Boolean);
  const keys = opt.byMonth ? values.map((v) => v.slice(0, 7)) : values;
  return [...new Set(keys)];
}

/** 이미 정렬된 목록을 칸으로 나눈다 → [칸 이름, 노트들][]. 묶지 않으면 이름이 빈 칸 하나.
 *
 *  칸의 차례: 달은 최신이 먼저(일지가 원래 그랬다), select 칸은 선택지 순서, 나머지는 가나다.
 *  값이 없는 노트는 `UNGROUPED`에 모여 맨 뒤에 선다. */
export function groupNotes(
  notes: readonly NoteSummary[],
  key: string,
  options: readonly GroupOption[],
): [string, NoteSummary[]][] {
  const opt = options.find((o) => o.key === key);
  if (!opt || opt.key === "none") return [["", [...notes]]];

  const map = new Map<string, NoteSummary[]>();
  for (const n of notes) {
    const keys = keysOf(n, opt);
    for (const k of keys.length > 0 ? keys : [UNGROUPED]) {
      const list = map.get(k);
      if (list) list.push(n);
      else map.set(k, [n]);
    }
  }

  const monthly = opt.key === "month" || opt.byMonth;
  const rank = (k: string) => {
    if (!opt.order) return 0;
    const i = opt.order.indexOf(k);
    return i < 0 ? opt.order.length : i;
  };
  return [...map.entries()].sort(([a], [b]) => {
    if (a === UNGROUPED) return 1;
    if (b === UNGROUPED) return -1;
    if (monthly) return b.localeCompare(a);
    return rank(a) - rank(b) || a.localeCompare(b, "ko");
  });
}
