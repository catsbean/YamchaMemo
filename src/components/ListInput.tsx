import { useRef } from "react";
import { createListCore, type ListCore } from "../lib/listInput";

/** 칩 바탕색 — 태그는 다른 곳(TagSuggestionRow)에서도 보라라서 맞춰 둔다 */
const TONE = {
  neutral: "bg-neutral-100 text-neutral-700",
  tag: "bg-violet-50 text-violet-700",
} as const;

/** 적어 두긴 했지만 제 구실을 못 하는 값 (예: 다른 글 이름에 가린 별칭) */
const WARN = "bg-amber-50 text-amber-700";

/** 입력칸의 class는 **고정 문자열이어야 한다**.
 *  값에 따라 바뀌면 React가 class를 통째로 다시 써서, 조합 중 상태 기계가 붙여 둔
 *  `ime-composing` 표시가 날아간다 (`ime.ts`의 같은 주의). */
const INPUT_CLS =
  "min-w-24 flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-neutral-400";

export interface ListInputProps {
  items: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** 칸 전체에 붙는 설명 (마우스를 올렸을 때) */
  title?: string;
  /** `field`는 폼 칸처럼 테두리를 두르고, `inline`은 본문 위에 얹혀 있다가 눌러야 드러난다 */
  variant?: "field" | "inline";
  tone?: keyof typeof TONE;
  className?: string;
  /** 값마다 색을 달리할 때 — `warn`이면 호박색 */
  chipTone?: (item: string) => "warn" | undefined;
  /** 그 값의 칩에 붙일 설명 */
  chipTitle?: (item: string) => string | undefined;
}

/**
 * 값 여러 개를 칩으로 담는 입력칸 — 태그·별칭처럼 "몇 개든 될 수 있는 칸".
 *
 * 쉼표를 구분자로 쓰는 **글자 그대로의 한 줄**은 겉보기에 간단하지만, 통제 입력으로
 * 만들면 쉼표를 치는 순간 값이 정규화돼 되돌아와서 두 번째 값을 시작할 수가 없다.
 * 그래서 확정된 값은 칩으로 굳히고, 입력칸에는 지금 치는 것만 남긴다.
 * 상태 기계와 그 까닭은 `src/lib/listInput.ts`에 있다.
 */
export default function ListInput({
  items,
  onChange,
  placeholder,
  title,
  variant = "field",
  tone = "neutral",
  className = "",
  chipTone,
  chipTitle,
}: ListInputProps) {
  const ref = useRef<HTMLInputElement | null>(null);
  // 콜백·값은 매 렌더 최신으로 갈아 끼우되(오래된 클로저 방지) 상태 기계는 한 번만 만든다
  const opts = useRef({ items, onChange });
  opts.current = { items, onChange };
  const core = useRef<ListCore | null>(null);
  if (!core.current) core.current = createListCore(ref, () => opts.current);

  const box =
    variant === "inline"
      ? "border-transparent hover:border-neutral-200 focus-within:border-neutral-400 focus-within:bg-white"
      : "border-neutral-300 bg-white focus-within:border-neutral-500";

  return (
    <div
      className={`flex w-full flex-wrap items-center gap-1 rounded border px-1.5 py-1 ${box} ${className}`}
      // 칩 사이 빈 곳을 눌러도 글을 이어 쓸 수 있게 (칸 전체가 입력칸처럼 보인다)
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        ref.current?.focus();
      }}
    >
      {items.map((item, i) => (
        <span
          key={`${i}:${item}`}
          title={chipTitle?.(item)}
          className={`inline-flex max-w-full shrink-0 items-center gap-0.5 rounded-full py-0.5 pl-2 pr-1 text-2xs ${
            chipTone?.(item) === "warn" ? WARN : TONE[tone]
          }`}
        >
          <span className="truncate">{item}</span>
          <button
            type="button"
            // 칩은 손으로 지우는 것이지 키보드로 훑을 거리가 아니다 — Tab 순서에서 뺀다
            tabIndex={-1}
            title={`'${item}' 지우기`}
            className="shrink-0 rounded-full px-1 leading-none opacity-50 hover:opacity-100"
            // 포커스를 뺏기지 않아야 입력칸에 쓰던 글자가 blur 확정에 휩쓸리지 않는다
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(items.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className={INPUT_CLS}
        // 값은 DOM이 소유한다 — value/onChange를 주면 조합 중 글자가 깨진다
        defaultValue=""
        placeholder={items.length === 0 ? placeholder : ""}
        title={title}
        {...core.current.handlers}
      />
    </div>
  );
}
