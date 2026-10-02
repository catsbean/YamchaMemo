import { useVault } from "../../stores/vault";

/** 화면 밝기 — 라이트·다크·시스템 설정 */
export default function ThemeSection() {
  const { theme, setTheme } = useVault();

  return (
    <section className="mb-5">
      <h3 className="mb-2 text-sm font-semibold text-neutral-600">화면 밝기</h3>
      <div className="flex gap-1.5 text-sm">
        {(
          [
            ["light", "라이트", "밝은 화면"],
            ["dark", "다크", "어두운 화면"],
            ["system", "시스템 설정", "운영체제를 따릅니다"],
          ] as const
        ).map(([v, label, desc]) => (
          <button
            key={v}
            className={`flex-1 rounded-md border px-3 py-2 text-left ${
              theme === v
                ? "border-neutral-800 bg-neutral-50 font-medium"
                : "border-neutral-200 text-neutral-500 hover:border-neutral-400"
            }`}
            onClick={() => setTheme(v)}
          >
            <span className="block">{label}</span>
            <span className="block text-2xs text-neutral-400">{desc}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
