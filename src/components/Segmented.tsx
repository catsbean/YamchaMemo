/** 하나만 고르는 가로 세그먼트.
 *
 *  칩(여러 개 고르기)과 생김새를 일부러 다르게 둔다 — 붙어 있는 칸은 "이 중 하나",
 *  떨어진 동그란 칩은 "고른 만큼"이라는 뜻이 되도록. */
export default function Segmented<T extends string>({
  value,
  options,
  onChange,
  className = "",
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={`flex gap-1 text-xs ${className}`}>
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          className={`rounded px-2.5 py-1 ${
            value === v
              ? "bg-neutral-800 text-white"
              : "text-neutral-500 hover:bg-neutral-100"
          }`}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
