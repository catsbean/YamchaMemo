import { useVault } from "../../stores/vault";

/** 독서기록에서 책을 고르는 창의 모양 */
export default function BookPickerSection() {
  const { bookPickerView, setBookPickerView } = useVault();

  return (
    <section className="mb-5">
      <h3 className="mb-2 text-sm font-semibold text-neutral-600">
        독서기록 책 선택 팝업
      </h3>
      <div className="flex gap-1.5 text-sm">
        {(
          [
            ["grid", "책장(표지)"],
            ["list", "목록"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            className={`rounded-md border px-3 py-1.5 ${
              bookPickerView === v
                ? "border-neutral-800 bg-neutral-50 font-medium"
                : "border-neutral-200 text-neutral-500 hover:border-neutral-400"
            }`}
            onClick={() => setBookPickerView(v)}
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}
