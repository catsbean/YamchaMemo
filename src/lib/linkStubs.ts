// 없는 글로 이어진 `[[링크]]`의 대상을 자유노트에 만들어 두고, 쓸모없어진 빈 글을 거둔다.
//
// 만드는 일과 치우는 일은 백엔드(`yamcha_core::linkstub`)가 한다 — 있으면 만들지 않고,
// 손댄 글은 치우지 않는다는 판정은 거기서 다시 한다. 여기는 **언제 무엇을 물어볼지**만 정한다.
//
// ## 언제
// 노트를 저장한 직후(자동저장 포함)와 기록을 [추가]한 직후. 저장 뒤라야 색인이 새 본문을
// 알고 있어 "아무도 안 가리킨다"를 믿을 수 있다.
//
// ## 무엇을 만드는가
// **이번에 새로 쓴 링크만.** 글을 읽어 온 순간 이미 있던 끊긴 링크는 건드리지 않는다
// (`markLinkBaseline`). 기록 [추가]는 덧붙인 글 안의 링크만 본다.
//
// ## 무엇을 빼는가
// **커서가 들어 있는 링크.** `[[회의]]`를 `[[회의록]]`으로 고치는 동안에는 자동저장이
// 사이사이 돈다. 그때마다 만들면 `회의ㄹ`·`회의로` 같은 글이 생겼다 치워졌다 한다.
//
// ## 무엇을 거두는가
// **이 창에서 이번에 만든 글만.** 링크를 고쳐 쓴 바람에 아무도 안 가리키게 된 빈 글이다.
// 예전에 만들어 둔 빈 글까지 여기서 훑지 않는다 — 조용히 사라져도 되는 것은 방금 만든 것뿐이다.

import { commands, type CreatedLink, type NoteSummary } from "../bindings";
import { linkTargetOf, resolveLink } from "./resolveLink";

/** 한 번에 자동으로 만드는 최대 편수 (백엔드 `MAX_LINK_STUBS`와 같은 값) */
export const MAX_LINK_STUBS = 20;

/** 본문에서 `[[링크]]`의 타깃들을 뽑는다 (겹치는 것은 한 번만).
 *  코드 블록과 인라인 코드 안의 `[[ ]]`는 링크가 아니라 글자다. */
export function linkTargetsIn(body: string): string[] {
  const prose = body
    // 울타리 코드 블록 (``` 또는 ~~~). 닫히지 않았으면 끝까지 코드로 본다
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, "")
    .replace(/`[^`\n]*`/g, "");
  const out: string[] = [];
  for (const m of prose.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
    const t = linkTargetOf(m[1]);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** 자동으로 만들지 않는 이름 (백엔드 `skip_reason`과 같은 규칙 — 거기서 다시 걸러진다) */
export function isCreatable(target: string): boolean {
  if (!target.trim()) return false;
  if (/[/\\]/.test(target)) return false; // 폴더까지 적은 링크
  if (/^\d{4}-\d{2}-\d{2}$/.test(target)) return false; // 일지의 자리
  return true;
}

/** 본문의 링크 가운데 만들어야 할 이름들 — 가리키는 글이 없고, 만들 수 있고, 커서 밖인 것 */
export function missingTargets(
  body: string,
  notes: NoteSummary[],
  cursorTarget: string | null,
): string[] {
  return linkTargetsIn(body).filter(
    (t) => t !== cursorTarget && isCreatable(t) && resolveLink(notes, t).length === 0,
  );
}

// ── 커서가 들어 있는 링크 ──
// 편집기가 자기를 등록해 둔다. 창 하나에 편집기는 하나뿐이라 변수 하나로 충분하다.
let cursorProbe: (() => string | null) | null = null;

/** 편집기가 "지금 커서가 든 링크의 타깃"을 알려 줄 함수를 등록한다 → 해제 함수 */
export function registerCursorLinkProbe(probe: () => string | null): () => void {
  cursorProbe = probe;
  return () => {
    if (cursorProbe === probe) cursorProbe = null;
  };
}

function cursorTarget(): string | null {
  try {
    return cursorProbe?.() ?? null;
  } catch {
    return null;
  }
}

// ── 열었을 때 이미 있던 링크 ──
// "링크를 **쓰면** 만든다"이지 "끊긴 링크가 있으면 만든다"가 아니다. 예전에 써 둔 끊긴 링크가
// 여럿인 글을 열어 오타 하나를 고쳤다고 빈 글이 줄줄이 생기면 안 된다. 글을 읽어 온 순간의
// 링크를 적어 두고, 그 뒤에 새로 나타난 것만 만든다. (예전 링크는 눌렀을 때 [만들기]가 뜬다)
const baselines = new Map<string, Set<string>>();

/** 디스크에서 글을 읽어 화면에 올릴 때 부른다 — 그때 이미 있던 링크는 자동으로 만들지 않는다 */
export function markLinkBaseline(source: string, body: string) {
  baselines.set(source, new Set(linkTargetsIn(body)));
}

// ── 이번에 만든 글들 (이 창에서) ──
/** 만든 글의 rel → 어느 글의 어떤 링크에서 만들었나 */
const made = new Map<string, { source: string; target: string }>();

export interface StubSync {
  /** 새로 만든 글들 */
  made: CreatedLink[];
  /** 거둔 글들의 rel */
  gone: string[];
  /** 만들 것이 너무 많아 하나도 만들지 않았다 — 그 개수 (아니면 0) */
  tooMany: number;
  /** 커서가 든 링크라 미뤄 둔 것이 있다 — 커서가 벗어난 뒤에 한 번 더 불러야 한다.
   *  (커서만 옮기면 저장이 돌지 않으므로, 부르는 쪽이 조금 뒤에 다시 물어야 만들어진다) */
  deferred?: boolean;
}

const NOTHING: StubSync = { made: [], gone: [], tooMany: 0 };

/** 저장 직후에 부른다. 없는 링크 대상을 만들고(`create`가 켜져 있을 때), 이 글에서 만들었다가
 *  링크가 사라진 빈 글을 거둔다. 실패해도 저장 흐름을 막지 않는다 — 빈 결과를 돌려준다. */
export async function syncLinkStubs(opts: {
  /** 방금 저장한 글 */
  source: string;
  body: string;
  /** 지금 알고 있는 노트 목록 (없는지 미리 걸러 백엔드를 덜 부른다) */
  notes: NoteSummary[];
  /** 자동 만들기 설정 */
  create: boolean;
  /** 방금 덧붙인 글(기록 [추가]). 주면 **그 안의 링크만** 새로 쓴 것으로 본다 —
   *  이미 확정된 글이라 커서도 기준선도 따지지 않는다. */
  added?: string;
}): Promise<StubSync> {
  const { source, body, create } = opts;
  const targets = linkTargetsIn(body);
  const out: StubSync = { made: [], gone: [], tooMany: 0 };

  // 1. 거두기 — 이 글에서 만들었는데 이제 이 글에 그 링크가 없는 것
  const stale = [...made.entries()]
    .filter(([, m]) => m.source === source && !targets.includes(m.target))
    .map(([rel]) => rel);
  if (stale.length > 0) {
    const r = await commands.pruneLinkStubs(stale, false);
    // 거둔 것도 못 거둔 것도(손댔거나 다른 글이 가리킨다) 더는 우리 몫이 아니다
    for (const rel of stale) made.delete(rel);
    if (r.status === "ok") out.gone = r.data;
  }

  // 2. 만들기
  const { want, deferred } = newTargets(opts, targets);
  if (!create) return out;
  out.deferred = deferred;
  if (want.length === 0) return out;
  if (want.length > MAX_LINK_STUBS) return { ...out, tooMany: want.length };
  const r = await commands.ensureLinkTargets(want);
  if (r.status !== "ok") return out;
  for (const m of r.data) made.set(m.rel_path, { source, target: m.target });
  out.made = r.data;
  return out;
}

/** 이번에 **새로 쓴** 링크 가운데 만들어야 할 이름들 */
function newTargets(
  opts: { source: string; body: string; notes: NoteSummary[]; added?: string },
  targets: string[],
): { want: string[]; deferred: boolean } {
  if (opts.added !== undefined) {
    // 덧붙인 글의 링크도 이제 이 글에 있던 것이 된다
    const base = baselines.get(opts.source);
    const fresh = missingTargets(opts.added, opts.notes, null);
    if (base) for (const t of linkTargetsIn(opts.added)) base.add(t);
    return { want: fresh, deferred: false };
  }
  const base = baselines.get(opts.source);
  if (!base) {
    // 읽어 온 순간을 못 봤다(옮기거나 이름을 바꾼 직후 등). 지금을 기준선으로 삼고 이번에는
    // 만들지 않는다 — 모르는 채로 만들면 예전 링크까지 한꺼번에 만들어 버린다.
    baselines.set(opts.source, new Set(targets));
    return { want: [], deferred: false };
  }
  const held = cursorTarget();
  const all = missingTargets(opts.body, opts.notes, null).filter((t) => !base.has(t));
  return { want: all.filter((t) => t !== held), deferred: held !== null && all.includes(held) };
}

/** 방금 만든 것을 되돌린다 → 거둔 글들. 링크가 본문에 남아 있어도 거두지만 손댄 글은 남는다. */
export async function undoLinkStubs(rels: string[]): Promise<string[]> {
  for (const rel of rels) made.delete(rel);
  const r = await commands.pruneLinkStubs(rels, true);
  return r.status === "ok" ? r.data : [];
}

export { NOTHING as NO_STUB_SYNC };

/** 시험용 — 이번에 만든 글 기억을 비운다 */
export function resetLinkStubSession() {
  made.clear();
  baselines.clear();
  cursorProbe = null;
}

// ── 자동완성의 "새 글로" 줄 ──
// 자동 만들기가 켜져 있을 때만 그 줄을 보인다. 편집기·입력창이 스토어를 거치지 않고 물어볼 수
// 있게 여기 값 하나로 둔다(노트 창·담기 창은 스토어를 초기화하지 않는다). 기본은 설정의 기본값.
let autoCreate = true;

/** 설정을 읽었거나 바꿨을 때 알려 둔다 */
export function setAutoCreateHint(on: boolean) {
  autoCreate = on;
}

/** 자동완성 목록 끝에 붙일 "이 이름으로 새 글" 후보 — 붙일 까닭이 없으면 null.
 *
 *  맞는 후보가 없으면 목록이 그냥 사라져서, 없는 이름을 쳐도 되는지 알 길이 없었다.
 *  고르면 `[[이름]]`이 들어가고, 글은 저장될 때(기록은 [추가]할 때) 자유노트에 생긴다. */
export function newNoteOption(
  query: string,
  names: { label: string }[],
): { label: string; insert: string; detail: string } | null {
  const name = query.trim();
  if (!autoCreate || !name || !isCreatable(name)) return null;
  if (names.some((o) => o.label === name)) return null;
  return { label: name, insert: name, detail: "새 글로 · 자유노트" };
}
