import { useVault } from "../../stores/vault";

/** 노트 삭제 전 확인 단계 */
export default function DeleteConfirmSection() {
  const { deleteConfirm, setDeleteConfirm } = useVault();

  return (
    <section className="mb-5">
      <h3 className="mb-2 text-sm font-semibold text-neutral-600">삭제</h3>
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={deleteConfirm}
          onChange={(e) => setDeleteConfirm(e.target.checked)}
        />
        <span>
          삭제 전 확인 단계 거치기
          <span className="block text-xs text-neutral-400">
            노트 삭제는 [삭제] → [삭제 확인] 두 번을 누릅니다. 끄면 확인
            버튼 대신 [삭제]를 한 번 더 누르는 방식이 됩니다
          </span>
        </span>
      </label>
    </section>
  );
}
