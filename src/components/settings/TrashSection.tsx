import { useVault } from "../../stores/vault";
import Segmented from "../Segmented";
import { Section } from "./ui";

/** 휴지통 자동 비우기 — 휴지통 자체는 사이드바 🗑️ 링크로 연다 */
export default function TrashSection() {
  const { trashRetentionDays, setTrashRetention } = useVault();

  return (
    <Section
      title="휴지통 자동 비우기"
      desc={
        <>
          오래된 휴지통 항목을 영구 삭제합니다. 휴지통은 왼쪽 아래 <b className="font-medium">🗑️ 휴지통</b>에서
          엽니다.
        </>
      }
    >
      <Segmented
        value={String(trashRetentionDays)}
        options={[
          ["0", "안 함"],
          ["7", "7일 지나면"],
          ["30", "30일 지나면"],
        ]}
        onChange={(v) => setTrashRetention(Number(v))}
      />
    </Section>
  );
}
