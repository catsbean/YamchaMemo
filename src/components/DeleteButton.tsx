import { useEffect, useState } from "react";
import { useVault } from "../stores/vault";

/** 노트 삭제 버튼 — 기록·할 일·분류 제거와 같은 [삭제 확인][취소] 꼴로 묻는다.
 *
 *  설정의 "삭제 전 확인 단계"가 켜져 있으면 [삭제] → [삭제 확인][취소],
 *  꺼져 있으면 [삭제] → [삭제하시겠어요?] 두 번 누르기.
 *  어느 쪽이든 한 번에 지워지지는 않으며, 4초간 가만두면 원래대로 돌아간다. */
export default function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const deleteConfirm = useVault((s) => s.deleteConfirm);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!asking) return;
    const t = setTimeout(() => setAsking(false), 4000);
    return () => clearTimeout(t);
  }, [asking]);

  if (asking && deleteConfirm) {
    return (
      <span className="flex gap-1">
        <button
          className="rounded bg-rose-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-rose-500"
          onClick={() => {
            setAsking(false);
            onDelete();
          }}
        >
          삭제 확인
        </button>
        <button
          className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
          onClick={() => setAsking(false)}
        >
          취소
        </button>
      </span>
    );
  }

  return (
    <button
      className={`rounded px-2 py-1 text-xs transition-colors ${
        asking
          ? "bg-rose-100 font-bold text-rose-600 ring-1 ring-rose-300"
          : "text-rose-500 hover:bg-rose-50"
      }`}
      onClick={() => {
        if (!asking) {
          setAsking(true);
        } else {
          // 확인 단계 꺼짐: 두 번째 클릭에서 바로 삭제
          setAsking(false);
          onDelete();
        }
      }}
    >
      {asking ? "삭제하시겠어요?" : "삭제"}
    </button>
  );
}
