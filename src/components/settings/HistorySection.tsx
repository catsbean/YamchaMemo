import { useState } from "react";
import { commands } from "../../bindings";
import {
  useVault,
} from "../../stores/vault";

const HISTORY_MAX_OPTIONS: [number, string][] = [
  [0, "남기지 않음"],
  [5, "5개"],
  [20, "20개 (권장)"],
  [50, "50개"],
];

const HISTORY_INTERVAL_OPTIONS: [number, string][] = [
  [60, "1분"],
  [300, "5분 (권장)"],
  [1800, "30분"],
];

/** 편집 기록 — 저장 직전 스냅샷의 보관 정책과 비우기 */
export default function HistorySection() {
  const { historyMax, historyIntervalSecs, setHistoryPolicy } = useVault();
  const [purging, setPurging] = useState(false);
  const [purged, setPurged] = useState<number | null>(null);

  async function purge() {
    setPurging(true);
    const r = await commands.purgeHistory();
    setPurging(false);
    if (r.status === "ok") {
      setPurged(r.data);
      setTimeout(() => setPurged(null), 3000);
    }
  }

  return (
    <section className="mb-5">
      <h3 className="mb-1 text-sm font-semibold text-neutral-600">편집 기록</h3>
      <p className="mb-2 text-xs text-neutral-400">
        저장하기 직전의 내용을 남겨 두었다가, 편집기의 🕘 버튼으로 되돌릴 수
        있습니다. 내용이 크게 줄어드는 저장은 간격과 상관없이 항상 남깁니다.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-500 focus:outline-none"
          value={historyMax}
          onChange={(e) =>
            setHistoryPolicy(Number(e.target.value), historyIntervalSecs)
          }
          title="노트 하나당 보관할 기록 개수"
        >
          {HISTORY_MAX_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>
              노트당 {label}
            </option>
          ))}
        </select>
        <select
          className="rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-500 focus:outline-none disabled:opacity-40"
          value={historyIntervalSecs}
          disabled={historyMax === 0}
          onChange={(e) =>
            setHistoryPolicy(historyMax, Number(e.target.value))
          }
          title="이 시간이 지나야 새 기록을 남깁니다"
        >
          {HISTORY_INTERVAL_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>
              최소 간격 {label}
            </option>
          ))}
        </select>
        <button
          className="rounded border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-500 disabled:opacity-40"
          disabled={purging}
          onClick={purge}
        >
          {purging ? "비우는 중…" : "기록 모두 비우기"}
        </button>
        {purged != null && (
          <span className="text-xs text-emerald-600">{purged}개 삭제됨</span>
        )}
      </div>
    </section>
  );
}
