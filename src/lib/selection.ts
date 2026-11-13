import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** `order`에서 `a`와 `b` 사이(둘 다 포함)의 것들. 어느 쪽이든 목록에 없으면 `b`만. */
export function rangeBetween(order: string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return j < 0 ? [] : [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** 고른 것에 한 번의 누름을 반영한다 (순수 함수 — 시험이 직접 돌린다).
 *
 *  - 그냥 누르면 그 줄만 켜고 끈다
 *  - Shift를 누른 채 누르면 **마지막에 누른 줄부터 여기까지**를 한꺼번에 — 마지막 줄이
 *    켜진 것이었으면 켜고, 꺼진 것이었으면 끈다 (탐색기·메일 목록과 같은 약속) */
export function applyPick(
  selected: ReadonlySet<string>,
  anchor: string | null,
  order: string[],
  id: string,
  shift: boolean,
): Set<string> {
  const next = new Set(selected);
  if (shift && anchor && anchor !== id && order.includes(anchor)) {
    const on = selected.has(anchor);
    for (const x of rangeBetween(order, anchor, id)) {
      if (on) next.add(x);
      else next.delete(x);
    }
    return next;
  }
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** 목록에서 여러 줄 고르기.
 *
 *  `order`는 화면에 놓인 순서 그대로의 id들(아직 그리지 않은 줄까지) — Shift 범위가 이 순서를
 *  따른다. `resetKey`가 바뀌면(분류·필터·정렬·묶기) 고른 것을 푼다: 안 보이게 된 줄이 골라진 채
 *  남아 있다가 함께 옮겨지면 안 된다. 목록에서 사라진 줄(지워졌거나 옮겨졌다)도 저절로 빠진다. */
export function useSelection(order: string[], resetKey: string) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const orderRef = useRef(order);
  orderRef.current = order;

  const clear = useCallback(() => {
    anchor.current = null;
    setSelected((cur) => (cur.size === 0 ? cur : new Set()));
  }, []);

  useEffect(clear, [resetKey, clear]);

  // 목록에서 사라진 줄은 고른 것에서도 뺀다
  const live = useMemo(() => {
    if (selected.size === 0) return selected;
    const here = new Set(order);
    let dropped = false;
    const kept = new Set<string>();
    for (const id of selected) {
      if (here.has(id)) kept.add(id);
      else dropped = true;
    }
    return dropped ? kept : selected;
  }, [selected, order]);

  const pick = useCallback((id: string, shift: boolean) => {
    // 시작 줄은 **지금** 읽어 둔다 — setState에 넘긴 함수는 나중에(다시 그릴 때) 돌아서,
    // 그 안에서 읽으면 이미 방금 누른 줄로 바뀌어 있다 (Shift 범위가 안 먹었다)
    const from = anchor.current;
    anchor.current = id;
    setSelected((cur) => applyPick(cur, from, orderRef.current, id, shift));
  }, []);

  /** 여러 줄을 한꺼번에 켜거나 끈다 (묶음 머리글의 "이 묶음 전부") */
  const setMany = useCallback((ids: string[], on: boolean) => {
    setSelected((cur) => {
      const next = new Set(cur);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  // Esc로 푼다 — 고른 것이 있을 때만 듣는다
  const active = live.size > 0;
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // 글을 쓰는 중의 Esc(추천 닫기 등)는 가로채지 않는다
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, .cm-editor") || t.isContentEditable)) return;
      clear();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, clear]);

  return { selected: live, pick, setMany, clear };
}
