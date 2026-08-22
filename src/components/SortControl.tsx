import { useMemo } from "react";
import type { SortOption, SortSpec } from "../lib/sort";
import { defaultDir, normalizeSort } from "../lib/sort";
import { useVault } from "../stores/vault";

/** 이 화면의 정렬을 읽고 쓴다. 고른 값은 분류별로 남아 다음에 열 때 그대로 돌아온다.
 *
 *  저장된 값을 그대로 믿지 않고 매번 다듬는다 — 사용자가 분류에서 칸을 지우면
 *  그 칸으로 세우라는 옛 설정만 남아, 아무 버튼도 켜지지 않은 화면이 된다. */
export function useSort(
  scope: string,
  options: readonly SortOption[],
): [SortSpec, (spec: SortSpec) => void] {
  const { sorts, setSort } = useVault();
  const saved = sorts[scope];
  const spec = useMemo(() => normalizeSort(saved, options), [saved, options]);
  return [spec, (next) => void setSort(scope, next)];
}

/** 정렬 고르개 — 표 머리글처럼 쓴다.
 *
 *  다른 칸을 누르면 그 칸으로 바꾸고, **켜져 있는 칸을 다시 누르면 차례를 뒤집는다.**
 *  방향 버튼을 따로 두지 않은 이유다 — 두 번 누르는 자리가 하나면 배울 것이 없다. */
export default function SortControl({
  options,
  value,
  onChange,
  className = "",
}: {
  options: readonly SortOption[];
  value: SortSpec;
  onChange: (spec: SortSpec) => void;
  className?: string;
}) {
  if (options.length < 2) return null;
  return (
    <div className={`flex flex-wrap items-center gap-1 text-xs ${className}`}>
      <span className="mr-0.5 shrink-0 text-2xs text-neutral-400">정렬</span>
      {options.map((o) => {
        const on = value.key === o.key;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            className={`shrink-0 rounded px-2 py-1 ${
              on
                ? "bg-neutral-200 text-neutral-800"
                : "text-neutral-400 hover:bg-neutral-100"
            }`}
            title={
              on
                ? "다시 누르면 차례가 뒤집힙니다"
                : `${o.label} 순으로 줄 세우기`
            }
            onClick={() =>
              onChange(
                on
                  ? { key: o.key, dir: value.dir === "asc" ? "desc" : "asc" }
                  : { key: o.key, dir: defaultDir(o.key) },
              )
            }
          >
            {o.label}
            {on && (
              <span className="ml-0.5 text-neutral-500">
                {value.dir === "asc" ? "↑" : "↓"}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
