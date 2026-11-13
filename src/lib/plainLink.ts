// `[[` 없이 쓰다가 글 이름이 나오면 링크로 바꿔 주겠냐고 추천한다 (설정에서 켠 사람만).
//
// `[[`는 "링크를 걸겠다"는 뜻이 분명하지만 평범한 타이핑은 아니다. 그래서 여기 규칙은
// 전부 **덜 끼어드는 쪽**으로 기운다.
//
// - 낱말 **앞부터** 맞을 때만, 띄어쓰기를 뺀 2글자 이상부터 (`[[` 뒤에서는 가운데도 맞춘다)
// - 낱말이 이름보다 길어지면(`abc를`) 닫힌다 — 조사를 떼어 다시 찾지 않는다
// - 여러 낱말 이름(`역사적 예수`)은 띄어쓰기를 넘어 이어 맞춘다 (최대 네 낱말)
// - 날짜 모양 이름(일지)은 후보에서 뺀다
// - 이미 링크 안·코드·주소·태그·제목 줄에서는 띄우지 않는다
//
// 고르는 방식(목록은 뜨되 아무것도 골라 두지 않는다)은 화면 쪽이 맡는다 —
// `WikiLinkSuggest`와 `editor/wikilink.ts`.

import type { LinkOption } from "./resolveLink";

// ── 설정 ──
// 편집기·입력창이 스토어를 거치지 않고 물어볼 수 있게 값 하나로 둔다
// (노트 창·담기 창은 스토어를 초기화하지 않는다). 기본은 꺼짐.
let enabled = false;

export function setPlainLinkSuggest(on: boolean) {
  enabled = on;
}

export function plainLinkSuggestOn(): boolean {
  return enabled;
}

// ── 찾기 ──

/** 앞글자로 빨리 찾으려고 이름을 줄 세워 둔 것 */
interface PlainIndex {
  /** 소문자로 바꾼 이름 — 코드 순으로 줄 세워 같은 앞글자가 한 덩어리로 모인다 */
  keys: string[];
  options: LinkOption[];
}

/** 후보 배열마다 한 번만 만든다 (후보 배열은 노트가 바뀌기 전까지 같은 것이다) */
const indexes = new WeakMap<LinkOption[], PlainIndex>();

function indexOf(options: LinkOption[]): PlainIndex {
  let ix = indexes.get(options);
  if (!ix) {
    const rows = options
      // 일지는 제목이 날짜다 — 날짜를 쓸 때마다 추천이 뜨면 곤란하다
      .filter((o) => !/^\d{4}-\d{2}-\d{2}/.test(o.label))
      .map((o) => ({ key: o.label.toLowerCase(), o }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    ix = { keys: rows.map((r) => r.key), options: rows.map((r) => r.o) };
    indexes.set(options, ix);
  }
  return ix;
}

/** `prefix`로 시작하는 이름들 (이분 탐색으로 첫 자리를 찾고 이어서 훑는다) */
function withPrefix(ix: PlainIndex, prefix: string, max: number): LinkOption[] {
  let lo = 0;
  let hi = ix.keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ix.keys[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  const out: LinkOption[] = [];
  for (let i = lo; i < ix.keys.length && out.length < max; i++) {
    if (!ix.keys[i].startsWith(prefix)) break;
    out.push(ix.options[i]);
  }
  return out;
}

/** 낱말이 시작될 수 있는 자리의 앞 글자 — 띄어쓰기와 여는 문장부호 */
const BEFORE_WORD = /[\s([{"'“‘<>·,.:;!?~/-]/;

/** 한 줄에서 추천을 띄우면 안 되는 자리인가 (`before` = 그 줄의 커서 앞 글자들).
 *  코드 블록·frontmatter처럼 줄 밖을 봐야 아는 것은 편집기가 구문 트리로 따로 거른다. */
export function plainLinkBlocked(before: string): boolean {
  // 아직 닫히지 않은 `[[` 안 — 그쪽 자동완성의 자리다
  if (/\[\[[^\]]*$/.test(before)) return true;
  // 인라인 코드 안 (백틱이 홀수 개)
  if ((before.match(/`/g)?.length ?? 0) % 2 === 1) return true;
  // 제목 줄
  if (/^\s*#{1,6}\s/.test(before)) return true;
  // 지금 쓰는 덩어리가 주소·태그·파일 경로
  const token = before.match(/\S*$/)?.[0] ?? "";
  if (/^(#|@|https?:|www\.)/i.test(token) || token.includes("://")) return true;
  return false;
}

export interface PlainLinkMatch {
  /** `before`에서 바꿀 글자가 시작되는 자리 */
  from: number;
  /** 사용자가 친 글자 (`before.slice(from)`) */
  typed: string;
  options: LinkOption[];
}

/** 커서 앞 글자에서 "글 이름을 쓰는 중"을 찾는다. 없으면 null.
 *
 *  가장 긴 낱말 묶음부터 대 본다 — `역사적 예`까지 쳤으면 `예…`보다 `역사적 예…`가 먼저다. */
export function plainLinkMatch(
  options: LinkOption[],
  before: string,
  max = 8,
): PlainLinkMatch | null {
  if (plainLinkBlocked(before)) return null;
  // 낱말이 시작되는 자리들을 뒤에서부터 (가까운 것 → 먼 것, 최대 네 낱말)
  const starts: number[] = [];
  for (let i = before.length; i > 0 && starts.length < 4; i--) {
    const atWordStart = !/\s/.test(before[i - 1]) && (i === 1 || BEFORE_WORD.test(before[i - 2]));
    if (atWordStart) starts.push(i - 1);
  }
  const ix = indexOf(options);
  for (const from of starts.reverse()) {
    const typed = before.slice(from);
    if (typed.replace(/\s/g, "").length < 2) continue;
    const found = withPrefix(ix, typed.toLowerCase(), max);
    if (found.length > 0) return { from, typed, options: found };
  }
  return null;
}
