import { useState } from "react";
import { useVault } from "../../stores/vault";
import { Section } from "./ui";

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
    <Section
      title="vault"
      desc={
        <>
          메모를 저장하는 폴더입니다. 다른 폴더로 바꿔도 지금 폴더의 메모는 그대로 남습니다.
          <span className="mt-1 block break-all text-neutral-600">{vaultPath}</span>
        </>
      }
      help="전체 재색인은 검색·백링크·태그가 이상할 때 씁니다. 메모는 건드리지 않고 vault의 모든 노트를 다시 읽어 색인을 새로 만듭니다(노트가 많으면 몇십 초 걸립니다)."
    >
      <div className="flex flex-wrap gap-2">
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
    </Section>
  );
}
