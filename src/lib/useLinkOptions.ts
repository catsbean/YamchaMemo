import { useMemo, useRef } from "react";
import type { NoteSummary } from "../bindings";
import { linkNameSet, linkOptions, linkResolves, type LinkOption } from "./resolveLink";

/** 편집기에 넘길 `[[` 후보 꺼내기 함수.
 *
 *  편집기는 `[[` 뒤에서 글자를 칠 때마다 후보를 달라고 한다. 그때마다 `linkOptions`로
 *  전체 노트를 훑으면 링크를 치는 내내 그 값을 문다. 그렇다고 노트가 바뀔 때마다 미리
 *  만들어 두면(useMemo) 링크를 안 쓰는 저장에도 값을 치른다. **처음 달라고 할 때 만들고,
 *  노트·분류가 그대로인 동안은 같은 배열을 돌려준다.** */
export function useLinkOptions(
  notes: NoteSummary[],
  schemas: { id: string; label: string }[],
): () => LinkOption[] {
  const cache = useRef<{
    notes: NoteSummary[];
    schemas: { id: string; label: string }[];
    out: LinkOption[];
  } | null>(null);
  const input = useRef({ notes, schemas });
  input.current = { notes, schemas };
  const get = useRef(() => {
    const now = input.current;
    const hit = cache.current;
    if (hit && hit.notes === now.notes && hit.schemas === now.schemas) return hit.out;
    const out = linkOptions(now.notes, now.schemas);
    cache.current = { ...now, out };
    return out;
  });
  return get.current;
}

/** 편집기에 넘길 "가리키는 글이 없는 링크인가" 판정 — 노트 목록이 바뀔 때만 새로 만든다.
 *  목록을 아직 못 받았으면(빈 배열) 아무것도 흐리게 그리지 않는다 — 모든 링크가 없어 보이면 안 된다. */
export function useMissingLinkCheck(notes: NoteSummary[]): (target: string) => boolean {
  return useMemo(() => {
    if (notes.length === 0) return () => false;
    const names = linkNameSet(notes);
    return (target: string) => !linkResolves(names, target);
  }, [notes]);
}
