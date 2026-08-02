import type { TagSuggestion } from "../bindings";

/** 자동 태그 제안 칩 줄 — 누른 것만 담긴다.
 *
 *  색으로 성격을 구분한다: 고유명사는 보라(이미 쓰는 태그) 또는 중립(처음 보는 이름),
 *  범주는 호박색 — 본문에 그 말이 없고 분류에서 따라온 것이라 구분이 필요하다. */
export default function TagSuggestionRow({
  suggestions,
  onAdd,
  className = "mt-1 flex flex-wrap gap-1",
}: {
  suggestions: TagSuggestion[];
  onAdd: (tag: string) => void;
  /** 배치 위치에 따라 여백을 다르게 줄 때 (기본: 입력칸 아래) */
  className?: string;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className={className}>
      {suggestions.map((s) => (
        <button
          key={s.tag}
          type="button"
          title={s.reason}
          className={`rounded-full px-2 py-0.5 text-2xs ${
            s.category
              ? "bg-amber-50 text-amber-700 hover:bg-amber-100"
              : s.existing
                ? "bg-violet-50 text-violet-700 hover:bg-violet-100"
                : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
          }`}
          onClick={() => onAdd(s.tag)}
        >
          {s.existing ? "#" : "+"}
          {s.tag}
        </button>
      ))}
    </div>
  );
}
