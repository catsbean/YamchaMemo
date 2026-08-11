import { useVault } from "../stores/vault";
import Modal from "./Modal";

/** 이름이 겹치는 `[[링크]]`에서 어느 글인지 고르는 창.
 *
 *  자유노트와 회의록에 '중복노트'가 하나씩 있으면 `[[중복노트]]`만으로는 어느
 *  쪽인지 알 수 없다. 예전에는 목록에서 먼저 걸린 하나를 말없이 열었는데, 그건
 *  둘 중 하나를 몰래 고르는 것이라 사용자가 틀린 글을 보고 있어도 알 수가 없다.
 *  분류와 폴더 경로를 나란히 보여 주고 사람이 고르게 한다. */
export default function LinkPickerDialog() {
  const linkChoice = useVault((s) => s.linkChoice);
  const clearLinkChoice = useVault((s) => s.clearLinkChoice);
  const openNote = useVault((s) => s.openNote);
  const schemas = useVault((s) => s.schemas);

  if (!linkChoice) return null;
  const { target, hits } = linkChoice;

  return (
    <Modal
      onClose={clearLinkChoice}
      panelClassName="w-96 rounded-lg p-5 shadow-xl"
    >
      <h2 className="text-base font-bold">
        <span className="text-neutral-500">[[</span>
        {target}
        <span className="text-neutral-500">]]</span>
      </h2>
      <p className="mt-1 text-xs text-neutral-500">
        같은 이름의 글이 {hits.length}개 있습니다. 열 글을 고르세요.
      </p>

      <ul className="mt-3 flex flex-col gap-1">
        {hits.map(({ note, via, alias }) => (
          <li key={note.rel_path}>
            <button
              className="flex w-full flex-col items-start rounded-md border border-neutral-200 px-3 py-2 text-left hover:border-neutral-400 hover:bg-neutral-50"
              onClick={() => {
                clearLinkChoice();
                openNote(note.rel_path);
              }}
            >
              <span className="flex w-full items-center gap-2">
                <span className="truncate text-sm">
                  {note.title || note.rel_path}
                </span>
                <span className="ml-auto shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-2xs text-neutral-500">
                  {schemas.find((s) => s.id === note.note_type)?.label ??
                    note.note_type}
                </span>
              </span>
              <span className="mt-0.5 w-full truncate text-2xs text-neutral-400">
                {note.rel_path}
                {via === "alias" && alias && ` · 별칭 '${alias}'`}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-2xs text-neutral-400">
        늘 같은 글로 가게 하려면 링크에 폴더를 함께 적으세요 —{" "}
        <code>[[{hits[0].note.rel_path.replace(/\.md$/, "")}]]</code>
      </p>

      <div className="mt-3 flex justify-end">
        <button
          className="rounded px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100"
          onClick={clearLinkChoice}
        >
          취소
        </button>
      </div>
    </Modal>
  );
}
