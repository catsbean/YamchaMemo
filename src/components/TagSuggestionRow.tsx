import { useState } from "react";
import type { TagSuggestion } from "../bindings";

/** 한 번에 보여줄 칩 개수. 넘으면 `+N`으로 접어 둔다.
 *  칩은 이미 점수 순으로 와서(autotag.rs) 앞쪽이 곧 가장 그럴듯한 후보다. */
const DEFAULT_MAX = 5;

/** 자동 태그 제안 칩 줄 — 누른 것만 담긴다.
 *
 *  색으로 성격을 구분한다: 고유명사는 보라(이미 쓰는 태그) 또는 중립(처음 보는 이름),
 *  범주는 호박색 — 본문에 그 말이 없고 분류에서 따라온 것이라 구분이 필요하다.
 *
 *  ## 왜 한 줄인가
 *  칩이 늘면 줄바꿈으로 아래가 밀려서, 태그를 고르는 사이에 입력칸·본문이 위아래로
 *  들썩였다. 이 줄은 **거들 뿐인 자리**라 화면 높이를 흔들 자격이 없다. 그래서 줄은
 *  하나로 고정하고 넘치면 옆으로 흐르게 둔다. 그래도 무한정 늘어놓으면 뒤쪽은 아무도
 *  안 보므로, 먼저 `MAX`개만 내놓고 나머지는 `+N`을 눌렀을 때 편다. */
export default function TagSuggestionRow({
  suggestions,
  onAdd,
  className = "mt-1",
  max = DEFAULT_MAX,
}: {
  suggestions: TagSuggestion[];
  onAdd: (tag: string) => void;
  /** 배치 위치에 따라 여백을 다르게 줄 때 (줄 배치 자체는 이 컴포넌트가 정한다) */
  className?: string;
  /** 접기 전에 보여줄 개수 */
  max?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  if (suggestions.length === 0) return null;

  const shown = expanded ? suggestions : suggestions.slice(0, max);
  const rest = suggestions.length - shown.length;

  return (
    <div
      className={`flex min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap thin-scrollbar ${className}`}
    >
      {shown.map((s) => (
        <button
          key={s.tag}
          type="button"
          title={s.reason}
          className={`shrink-0 rounded-full px-2 py-0.5 text-2xs ${
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
      {rest > 0 && (
        <button
          type="button"
          title={`추천 ${rest}개 더 보기`}
          className="shrink-0 rounded-full px-2 py-0.5 text-2xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
          onClick={() => setExpanded(true)}
        >
          +{rest}
        </button>
      )}
    </div>
  );
}
