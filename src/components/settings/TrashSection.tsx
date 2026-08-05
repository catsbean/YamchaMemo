import {
  useVault,
} from "../../stores/vault";

const TRASH_RETENTION_OPTIONS: [number, string][] = [
  [0, "안 함 (직접 비울 때까지 보관)"],
  [7, "7일 지나면 자동 삭제"],
  [30, "30일 지나면 자동 삭제"],
];

/** 휴지통 자동 비우기 — 휴지통 자체는 사이드바 🗑️ 링크로 연다 */
export default function TrashSection() {
  const { trashRetentionDays, setTrashRetention } = useVault();

  return (
    <section className="mb-5">
      <h3 className="mb-2 text-sm font-semibold text-neutral-600">
        휴지통 자동 비우기
      </h3>
      <select
        className="rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-500 focus:outline-none"
        value={trashRetentionDays}
        onChange={(e) => setTrashRetention(Number(e.target.value))}
        title="오래된 휴지통 항목을 자동으로 영구 삭제합니다"
      >
        {TRASH_RETENTION_OPTIONS.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
      <p className="mt-1.5 text-xs text-neutral-400">
        휴지통 자체는 왼쪽 아래 <b>🗑️ 휴지통</b>에서 열 수 있습니다.
      </p>
    </section>
  );
}
