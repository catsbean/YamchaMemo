// `[[` 뒤에 친 글자로 후보를 고르고 줄 세우는 규칙.
//
// 편집기(CodeMirror)와 기록 입력창(WikiLinkSuggest)이 **같은 함수**를 쓴다. 예전에는
// 편집기가 CodeMirror의 퍼지 매칭에 맡겼는데, 그쪽은 한 글자일 때 앞글자만 본다 —
// `[[이`를 치면 입력창에는 `이게맞다`·`2026-07-18 이야`·`에이스`가 뜨고 편집기에는
// `이게맞다` 하나만 떴다. 같은 문법인데 자리마다 답이 다르면 규칙으로 배울 수가 없다.

import type { LinkOption } from "./resolveLink";

/** 질의에 맞는 후보들. 앞부터 맞는 것을 위로 —
 *  `역사적`이면 `역사적 예수`가 `한국의 역사적 인물`보다 먼저 와야 한다. */
export function matchLinkOptions(
  options: LinkOption[],
  raw: string,
  max: number,
): LinkOption[] {
  const query = raw.trim().toLowerCase();
  // 초성만 쳤으면(`ㅇㅅ`) 이름의 초성과 견준다 — 띄어쓰기는 무시한다
  const byInitials = isInitials(query);
  const needle = byInitials ? query.replace(/\s+/g, "") : query;
  const keyOf = (o: LinkOption) => (byInitials ? squeezedInitials(o) : o.label.toLowerCase());

  const hit: { o: LinkOption; head: number }[] = [];
  for (const o of options) {
    const key = needle ? keyOf(o) : "";
    if (needle && !key.includes(needle)) continue;
    hit.push({ o, head: key.startsWith(needle) ? 0 : 1 });
  }
  hit.sort((a, b) => a.head - b.head || KO.compare(a.o.label, b.o.label));
  return hit.slice(0, max).map((h) => h.o);
}

/** 가나다순 비교기. `localeCompare("ko")`는 부를 때마다 비교기를 새로 찾는다 —
 *  후보 1만 5천 개를 줄 세울 때 그 값이 대부분이었다. */
const KO = new Intl.Collator("ko");

/** 후보의 초성(띄어쓰기 뺀 것). 후보 객체는 노트가 바뀌기 전까지 그대로라 한 번만 만든다 */
const initialsCache = new WeakMap<LinkOption, string>();
function squeezedInitials(o: LinkOption): string {
  let s = initialsCache.get(o);
  if (s === undefined) {
    s = initialsOf(o.label).replace(/\s+/g, "");
    initialsCache.set(o, s);
  }
  return s;
}

const INITIALS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

/** 초성(자음 낱자)만으로 된 질의인가 — `ㅇㅅ`, `ㅋㄹ ㅋㄷ` */
export function isInitials(query: string): boolean {
  return /^[ㄱ-ㅎ\s]+$/.test(query) && /[ㄱ-ㅎ]/.test(query);
}

/** 한글 음절을 초성으로 바꾼다 (`역사 개론` → `ㅇㅅ ㄱㄹ`). 한글이 아닌 글자는 소문자로 둔다 */
export function initialsOf(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out +=
      code >= 0xac00 && code <= 0xd7a3
        ? INITIALS[Math.floor((code - 0xac00) / 588)]
        : ch.toLowerCase();
  }
  return out;
}

/** 이 keydown을 어느 키로 볼 것인가.
 *
 *  한글을 조합 중일 때 윈도우 IME는 눌린 키를 `Process`(229)로 가려 보낸다. `[[이`까지
 *  치고 곧바로 ↓를 누르면 — 한글은 마지막 글자가 늘 조합 중이다 — 그 첫 ↓가 화살표로
 *  보이지 않아 헛돌았다. 물리 키(`code`)는 가려지지 않으므로 **화살표만** 그걸로 알아본다.
 *
 *  Enter·Tab은 풀어 주지 않는다. 조합 중 Enter는 글자를 확정하려는 것이고, 그 순간
 *  값을 갈아 끼우면 IME가 들고 있던 글자와 겹친다. 화살표는 값을 건드리지 않는다. */
export function suggestKey(e: { key: string; code?: string; keyCode?: number }): string {
  const hidden = e.key === "Process" || e.keyCode === 229;
  if (hidden && (e.code === "ArrowDown" || e.code === "ArrowUp")) return e.code;
  return e.key;
}
