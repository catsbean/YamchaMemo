import { useEffect, useRef, useState } from "react";

/** 긴 목록을 나눠 그린다 (8-3) — 처음엔 앞의 `initial`줄만, 끝에 다가가면 `step`줄씩 더.
 *
 *  1만 편 실측에서 자유노트 4,000줄을 한꺼번에 그리면 메뉴를 누를 때마다 0.5초, 독서기록 5,000줄은
 *  2초 동안 화면이 굳었다. 사람이 한 화면에 보는 건 수십 줄이다 — 나머지는 내려갈 때 그려도 늦지 않다.
 *  가상화 라이브러리를 들이지 않는다: 줄 높이가 제각각이고(묶음 제목·여러 줄 기록) 그려 둔 줄은
 *  그대로 두는 편이 스크롤·선택·우클릭 메뉴가 단순하다.
 *
 *  `resetKey`가 바뀌면(다른 분류·필터·정렬) 처음 길이로 돌아간다 — 바뀐 그 렌더에서 바로
 *  (효과로 미루면 한 번은 긴 목록을 다 그린 뒤에야 줄어든다).
 *
 *  `sentinel`을 목록 끝의 빈 요소에 달면, 그게 화면 가까이(800px) 오면 더 그린다. */
export function useIncremental(total: number, resetKey: unknown, initial = 200, step = 400) {
  const [state, setState] = useState({ key: resetKey, count: initial });
  let count = state.count;
  if (state.key !== resetKey) {
    count = initial;
    setState({ key: resetKey, count: initial });
  }
  const sentinel = useRef<HTMLDivElement | null>(null);
  const more = count < total;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setState((s) => ({ ...s, count: s.count + step }));
        }
      },
      { rootMargin: "800px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [more, count, step]);

  return { count: Math.min(count, total), more, sentinel };
}

/** 묶음([이름, 항목들][]) 목록에서 앞의 `budget`개만 남긴다 — 묶음 순서·안의 차례는 그대로 */
export function takeGroups<T>(groups: readonly (readonly [string, readonly T[]])[], budget: number): [string, T[]][] {
  const out: [string, T[]][] = [];
  let left = budget;
  for (const [name, items] of groups) {
    if (left <= 0) break;
    out.push([name, items.slice(0, left)]);
    left -= items.length;
  }
  return out;
}
