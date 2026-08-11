import { typeLabel, useVault } from "../stores/vault";
import { josaRo } from "../lib/note";
import Toast from "./Toast";

/** 분류를 옮긴 직후의 알림 — 어디로 갔는지 알리고 되돌릴 기회를 준다.
 *
 *  목록 우클릭 메뉴에서는 [새 창으로 열기] 바로 아래가 이동 항목이라 한 칸
 *  어긋나 눌리기 쉽다. 아무 말 없이 파일이 다른 폴더로 가 버리면, 그 글은
 *  찾을 방법을 아는 사람에게만 남아 있는 셈이 된다. */
export default function MoveUndoToast() {
  const moveUndo = useVault((s) => s.moveUndo);
  const undoMove = useVault((s) => s.undoMove);
  const dismiss = useVault((s) => s.dismissMoveUndo);
  const schemas = useVault((s) => s.schemas);

  if (!moveUndo) return null;
  const to = typeLabel(schemas, moveUndo.toTypeId);
  const from = typeLabel(schemas, moveUndo.fromTypeId);

  return (
    <Toast
      resetKey={moveUndo}
      onDone={dismiss}
      action={{
        label: "되돌리기",
        title: `${from}${josaRo(from)} 도로 옮깁니다`,
        onClick: undoMove,
      }}
    >
      <span className="font-medium">{to}</span>
      <span className="text-neutral-300">{josaRo(to)} 옮겼습니다</span>
      {/* 파일명이 바뀌었으면 반드시 알린다 — 파일명으로 걸어 둔 링크가 끊긴다 */}
      {moveUndo.renamedTo && (
        <span className="block text-2xs text-amber-300">
          같은 이름이 있어 '{moveUndo.renamedTo}'로 바뀌었습니다
        </span>
      )}
    </Toast>
  );
}
