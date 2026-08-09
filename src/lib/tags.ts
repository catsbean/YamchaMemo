// 본문에서 인라인 `#태그`를 뽑는다.
//
// 문자 집합은 Rust의 `parse::extract_inline_tags`와 **같아야 한다** — 색인에 들어간
// 태그와 화면이 세는 태그가 갈리면, 검색으로는 찾히는데 회고 필터에는 안 걸린다.

/** 한글·영문·숫자·슬래시·하이픈·언더스코어. 앞은 줄머리이거나 공백이어야 한다 */
const INLINE_TAG = /(?:^|\s)#([\p{L}\p{N}/_-]+)/gu;

/** 본문의 인라인 태그들 (중복 없이, 나온 순서대로) */
export function inlineTags(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(INLINE_TAG)) out.add(m[1]);
  return [...out];
}
