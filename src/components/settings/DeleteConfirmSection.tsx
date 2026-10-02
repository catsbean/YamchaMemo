import { useVault } from "../../stores/vault";
import { SwitchRow } from "./ui";

/** 노트 삭제 전 확인 단계 */
export default function DeleteConfirmSection() {
  const { deleteConfirm, setDeleteConfirm } = useVault();

  return (
    <SwitchRow
      title="삭제 전 확인"
      desc="켜면 노트를 지울 때 [삭제] → [삭제 확인] 두 번을 누릅니다. 끄면 [삭제]를 한 번 더 누르는 것으로 지웁니다. 지운 노트는 휴지통에 남습니다."
      checked={deleteConfirm}
      onChange={setDeleteConfirm}
    />
  );
}
