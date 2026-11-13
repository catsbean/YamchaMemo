import { typeLabel, useVault } from "../stores/vault";
import { josaRo } from "../lib/note";
import Toast from "./Toast";

/** 파일명 (`Free/메모.md` → `메모`) */
function stem(rel: string): string {
  return (rel.split("/").pop() ?? "").replace(/\.md$/i, "");
}

/** 여러 편을 한꺼번에 옮긴 직후의 알림 — 몇 편이 어디로 갔는지, 못 간 것은 왜인지 알리고
 *  한 번에 되돌릴 기회를 준다. (한 편 옮기기의 `MoveUndoToast`와 같은 약속) */
export default function MoveBatchToast() {
  const batch = useVault((s) => s.moveBatch);
  const undo = useVault((s) => s.undoMoveBatch);
  const dismiss = useVault((s) => s.dismissMoveBatch);
  const schemas = useVault((s) => s.schemas);

  if (!batch) return null;
  const to = typeLabel(schemas, batch.toTypeId);
  // 대상 폴더에 같은 파일명이 있어 이름이 바뀐 것 — 파일명으로 걸어 둔 링크가 끊긴다
  const renamed = batch.moved.filter((m) => stem(m.from) !== stem(m.to));

  return (
    <Toast
      resetKey={batch}
      onDone={dismiss}
      // 못 옮긴 까닭을 읽을 시간을 준다
      lifetime={batch.skipped.length > 0 ? 12000 : undefined}
      action={
        batch.moved.length > 0
          ? { label: "되돌리기", title: "옮긴 글을 모두 원래 분류로 도로 옮깁니다", onClick: undo }
          : undefined
      }
    >
      {batch.moved.length > 0 && (
        <>
          <span className="font-medium">{batch.moved.length}편</span>
          <span className="text-neutral-300">
            을 {to}
            {josaRo(to)} 옮겼습니다
          </span>
        </>
      )}
      {renamed.length > 0 && (
        <span
          className="block text-2xs text-amber-300"
          title={renamed.map((m) => `${stem(m.from)} → ${stem(m.to)}`).join("\n")}
        >
          같은 이름이 있어 {renamed.length}편의 파일명이 바뀌었습니다
        </span>
      )}
      {batch.skipped.length > 0 && (
        <span
          className="block text-2xs text-amber-300"
          title={batch.skipped.map((s) => `${stem(s.rel_path)} — ${s.reason}`).join("\n")}
        >
          {batch.skipped.length}편은 옮기지 못했습니다 — {batch.skipped[0].reason}
          {batch.skipped.length > 1 ? " 등" : ""}
        </span>
      )}
    </Toast>
  );
}
