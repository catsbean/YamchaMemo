import { useState } from "react";
import { useVault } from "../../stores/vault";

/** vault 위치와 전체 재색인. 재색인이 도는 동안엔 설정 창을 닫지 못한다(`onBusy`). */
export default function VaultSection({ onBusy }: { onBusy: (busy: boolean) => void }) {
  const { vaultPath, chooseVault, reindexAll } = useVault();
  const [reindexing, setReindexing] = useState(false);
  const [reindexDone, setReindexDone] = useState(false);
  const [reindexCount, setReindexCount] = useState<number | null>(null);

  async function runReindex() {
    setReindexing(true);
    onBusy(true);
    setReindexDone(false);
    try {
      const n = await reindexAll();
      setReindexCount(typeof n === "number" ? n : null);
      setReindexDone(true);
    } finally {
      setReindexing(false);
      onBusy(false);
    }
  }

  return (
    <section className="mb-5">
      <h3 className="mb-2 text-sm font-semibold text-neutral-600">Vault</h3>
      <p className="mb-1 break-all text-xs text-neutral-500">{vaultPath}</p>
      <div className="flex gap-2">
        <button
          className="rounded border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-500"
          onClick={chooseVault}
        >
          vault 변경
        </button>
        <button
          className="rounded border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-500 disabled:opacity-50"
          disabled={reindexing}
          onClick={runReindex}
        >
          {reindexing ? "재색인 중…" : "전체 재색인"}
        </button>
        {reindexDone && (
          <span className="self-center text-xs text-emerald-600">
            {reindexCount != null
              ? `${reindexCount}개 재색인 완료`
              : "완료"}
          </span>
        )}
      </div>
    </section>
  );
}
