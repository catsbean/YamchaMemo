import { useVault } from "../stores/vault";
import Toast from "./Toast";

/** 파일명 (`Free/메모.md` → `메모`) */
function stem(rel: string): string {
  return (rel.split("/").pop() ?? "").replace(/\.md$/i, "");
}

/** 못 한 것 한 줄 — 첫 까닭만 적고 나머지는 마우스를 올리면 */
function Skipped({ list }: { list: { rel_path: string; reason: string }[] }) {
  if (list.length === 0) return null;
  return (
    <span
      className="block text-2xs text-amber-300"
      title={list.map((s) => `${stem(s.rel_path)} — ${s.reason}`).join("\n")}
    >
      {list.length}편은 하지 못했습니다 — {list[0].reason}
      {list.length > 1 ? " 등" : ""}
    </span>
  );
}

/** 여러 편을 휴지통으로 보낸 직후 — 몇 편인지 알리고 한 번에 되살릴 기회를 준다 */
export function TrashBatchToast() {
  const batch = useVault((s) => s.trashBatch);
  const undo = useVault((s) => s.undoTrashBatch);
  const dismiss = useVault((s) => s.dismissTrashBatch);
  if (!batch) return null;
  const n = batch.trashed.length;
  return (
    <Toast
      resetKey={batch}
      onDone={dismiss}
      lifetime={batch.skipped.length > 0 ? 12000 : undefined}
      action={
        n > 0
          ? { label: "되돌리기", title: "휴지통에서 모두 제자리로 되살립니다", onClick: undo }
          : undefined
      }
    >
      {n > 0 && (
        <>
          <span className="font-medium">{n === 1 ? stem(batch.trashed[0].rel_path) : `${n}편`}</span>
          <span className="text-neutral-300">{n === 1 ? " — " : "을 "}휴지통으로 보냈습니다</span>
        </>
      )}
      <Skipped list={batch.skipped} />
    </Toast>
  );
}

/** 여러 편에 태그를 붙인 직후 */
export function TagBatchToast() {
  const batch = useVault((s) => s.tagBatch);
  const dismiss = useVault((s) => s.dismissTagBatch);
  if (!batch) return null;
  return (
    <Toast resetKey={batch} onDone={dismiss} lifetime={batch.skipped.length > 0 ? 12000 : undefined}>
      <span className="font-medium">#{batch.tag}</span>
      <span className="text-neutral-300">
        {batch.changed.length > 0 ? ` 을 ${batch.changed.length}편에 붙였습니다` : " — 새로 붙인 글이 없습니다"}
      </span>
      {batch.already.length > 0 && (
        <span className="block text-2xs text-neutral-400">
          {batch.already.length}편은 이미 그 태그가 있었습니다
        </span>
      )}
      <Skipped list={batch.skipped} />
    </Toast>
  );
}
