// 목록 정렬 — 자유노트·사용자 분류·책장·글쓰기가 같은 규칙으로 줄을 세운다.
//
// 화면마다 따로 만들지 않은 이유는 규칙이 같아야 하기 때문이다. 어느 화면에서는
// 빈 값이 맨 위로 오고 어느 화면에서는 맨 아래로 가면, 사용자는 정렬을 믿지 못하고
// 매번 눈으로 다시 훑게 된다.
import type { NoteSummary } from "../bindings";
import { fmDisplay } from "./note";

export type SortDir = "asc" | "desc";

/** 무엇으로 어느 방향으로 줄을 세울지.
 *  `key`는 `date`·`title`·`chars` 같은 노트 자체의 값이거나 frontmatter 칸 이름이다. */
export type SortSpec = { key: string; dir: SortDir };

/** 고를 수 있는 정렬 하나 — 화면의 정렬 버튼이 이 목록으로 만들어진다 */
export type SortOption = {
  key: string;
  label: string;
  /** select 칸처럼 정해진 차례가 있으면 그 순서로 (없으면 가나다) */
  order?: string[];
  /** 숫자로 견줄 칸 — 이게 없으면 평점 "10"이 "9"보다 앞에 선다 */
  numeric?: boolean;
};

export const DATE_SORT: SortOption = { key: "date", label: "날짜" };
export const TITLE_SORT: SortOption = { key: "title", label: "제목" };

export const DEFAULT_SORT: SortSpec = { key: "date", dir: "desc" };

/** 그 칸을 **처음** 골랐을 때의 방향.
 *  날짜는 최신이 먼저, 이름은 가나다순이 사람이 기대하는 첫 모습이다. */
export function defaultDir(key: string): SortDir {
  return key === "date" || key === "chars" ? "desc" : "asc";
}

/** 저장된 값이 예전 판이거나 없어진 칸을 가리키면 기본 정렬로 되돌린다 */
export function normalizeSort(
  saved: unknown,
  options: readonly SortOption[],
): SortSpec {
  if (!saved || typeof saved !== "object") return DEFAULT_SORT;
  const { key, dir } = saved as { key?: unknown; dir?: unknown };
  if (typeof key !== "string" || !options.some((o) => o.key === key)) {
    return DEFAULT_SORT;
  }
  return { key, dir: dir === "asc" || dir === "desc" ? dir : defaultDir(key) };
}

/** 정렬에 쓸 값 한 개를 문자열로 꺼낸다 (숫자 칸도 문자열로 받아 아래서 견준다) */
function valueOf(note: NoteSummary, key: string): string {
  if (key === "date") return note.date;
  if (key === "title") return note.title;
  if (key === "chars") return String(note.char_count);
  return fmDisplay(note, key);
}

function orderIndex(order: readonly string[], v: string): number {
  const i = order.indexOf(v);
  return i < 0 ? order.length : i;
}

/** 정렬한 새 배열을 돌려준다 (원본은 건드리지 않는다).
 *
 *  값이 빈 노트는 방향과 상관없이 늘 뒤로 보낸다 — 차례를 뒤집었더니 저자가 비어 있는
 *  책들이 먼저 쏟아지는 것은 찾기가 아니라 방해다. 값이 같은 것끼리는 언제나 같은
 *  차례(최신 → 제목)로 두어, 같은 화면을 다시 열어도 줄이 흔들리지 않게 한다. */
export function sortNotes(
  notes: readonly NoteSummary[],
  spec: SortSpec,
  options: readonly SortOption[] = [],
): NoteSummary[] {
  const opt = options.find((o) => o.key === spec.key);
  const sign = spec.dir === "asc" ? 1 : -1;
  return [...notes].sort((a, b) => {
    const va = valueOf(a, spec.key);
    const vb = valueOf(b, spec.key);
    if (!va !== !vb) return va ? -1 : 1;
    let d = 0;
    if (va !== vb) {
      if (opt?.order) {
        d = orderIndex(opt.order, va) - orderIndex(opt.order, vb);
        if (d === 0) d = va.localeCompare(vb, "ko");
      } else if (opt?.numeric) {
        const na = Number(va);
        const nb = Number(vb);
        d =
          Number.isNaN(na) || Number.isNaN(nb)
            ? va.localeCompare(vb, "ko")
            : na - nb;
      } else {
        d = va.localeCompare(vb, "ko");
      }
    }
    if (d !== 0) return d * sign;
    return (
      b.date.localeCompare(a.date) || a.title.localeCompare(b.title, "ko")
    );
  });
}
