import { useVault, type LayoutMode } from "../../stores/vault";

const LAYOUTS: { value: LayoutMode; label: string; desc: string }[] = [
  {
    value: "three",
    label: "3단 보기",
    desc: "메뉴 | 목록 | 편집기를 나란히 표시",
  },
  {
    value: "vertical",
    label: "상하 분할",
    desc: "목록을 위에, 편집기를 아래에 표시",
  },
  {
    value: "replace",
    label: "전체 전환",
    desc: "노트를 열면 목록 대신 편집기만 표시 (← 버튼으로 복귀)",
  },
];

/** 편집 시 목록 표시 — 3단·상하·전체 전환 */
export default function LayoutSection() {
  const { layout, setLayout } = useVault();

  return (
    <section className="mb-5">
      <h3 className="mb-2 text-sm font-semibold text-neutral-600">
        편집 시 목록 표시
      </h3>
      <div className="flex flex-col gap-1.5">
        {LAYOUTS.map((l) => (
          <label
            key={l.value}
            className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 ${
              layout === l.value
                ? "border-neutral-800 bg-neutral-50"
                : "border-neutral-200 hover:border-neutral-400"
            }`}
          >
            <input
              type="radio"
              className="mt-1"
              checked={layout === l.value}
              onChange={() => setLayout(l.value)}
            />
            <span>
              <span className="block text-sm font-medium">{l.label}</span>
              <span className="block text-xs text-neutral-500">{l.desc}</span>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}
