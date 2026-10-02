import { useState } from "react";
import { commands } from "../../bindings";
import { useVault } from "../../stores/vault";
import Segmented from "../Segmented";
import { DangerButton, Section } from "./ui";

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
    <Section
      title="편집 기록"
      desc="저장하기 직전의 내용을 남겨 두었다가 편집기의 🕘 버튼으로 되돌립니다. 내용이 크게 줄어드는 저장은 간격과 상관없이 늘 남깁니다."
    >
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-24 shrink-0 text-xs text-neutral-500">노트당 보관</span>
          <Segmented
            value={String(historyMax)}
            options={[
              ["0", "남기지 않음"],
              ["5", "5개"],
              ["20", "20개 (권장)"],
              ["50", "50개"],
            ]}
            onChange={(v) => setHistoryPolicy(Number(v), historyIntervalSecs)}
          />
        </div>
        {historyMax > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-24 shrink-0 text-xs text-neutral-500">최소 간격</span>
            <Segmented
              value={String(historyIntervalSecs)}
              options={[
                ["60", "1분"],
                ["300", "5분 (권장)"],
                ["1800", "30분"],
              ]}
              onChange={(v) => setHistoryPolicy(historyMax, Number(v))}
            />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <DangerButton
            label={purging ? "비우는 중…" : "기록 모두 비우기"}
            confirmLabel="모두 비우기"
            note="모든 노트의 편집 기록이 사라집니다"
            busy={purging}
            onConfirm={purge}
          />
          {purged != null && <span className="text-xs text-emerald-600">{purged}개 지웠습니다</span>}
        </div>
      </div>
    </Section>
  );
}
