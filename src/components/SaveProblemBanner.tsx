import { openNoteWindow } from "../lib/trashWindow";
import { useVault } from "../stores/vault";

/** 열린 노트를 저장하지 못했을 때 편집기 위에 뜨는 띠 — 밖에서 바뀌었거나(충돌) 쓰지 못했다.
 *  이 띠가 떠 있는 동안 다른 노트로 옮기거나 덧붙이는 일은 멈춘다(`ensureSaved`) —
 *  여기서 고르기 전까지 친 글자는 화면에 그대로 있다. 일반 노트와 책 화면이 함께 쓴다. */
export default function SaveProblemBanner() {
  const externalChanged = useVault((s) => s.externalChanged);
  const saveFailed = useVault((s) => s.saveFailed);
  const dirty = useVault((s) => s.dirty);
  const reloadCurrent = useVault((s) => s.reloadCurrent);
  const dismissExternalChange = useVault((s) => s.dismissExternalChange);
  const saveCurrent = useVault((s) => s.saveCurrent);
  const saveCopyOfCurrent = useVault((s) => s.saveCopyOfCurrent);

  // 사본은 옆 창에 띄운다 — 원래 노트(디스크 내용으로 다시 읽힘)와 나란히 놓고 옮겨 적게
  async function saveCopy() {
    const copy = await saveCopyOfCurrent();
    if (copy) await openNoteWindow(copy);
  }

  const copyButton = dirty && (
    <button
      className="rounded px-2 py-1 text-xs text-amber-700 hover:bg-amber-100"
      onClick={saveCopy}
      title="원래 노트는 그대로 두고, 화면의 글을 자유노트에 따로 남깁니다"
    >
      사본으로 저장
    </button>
  );

  if (externalChanged) {
    return (
      <div className="flex items-center justify-between gap-3 bg-amber-50 px-4 py-2 text-sm text-amber-800">
        <span>
          ⚠️ 이 노트가 외부(다른 앱)에서 수정되었습니다. 지금 저장하면 외부
          수정이 덮어써집니다.
        </span>
        <span className="flex shrink-0 gap-2">
          <button
            className="rounded bg-amber-600 px-2.5 py-1 text-xs text-white hover:bg-amber-500"
            onClick={reloadCurrent}
            title="내가 고친 것은 버리고 바뀐 파일을 읽어 옵니다"
          >
            다시 불러오기
          </button>
          <button
            className="rounded px-2 py-1 text-xs text-amber-600 hover:bg-amber-100"
            onClick={dismissExternalChange}
            title="바뀐 파일을 내 글로 덮어씁니다"
          >
            내 편집 유지
          </button>
          {copyButton}
        </span>
      </div>
    );
  }

  if (saveFailed && dirty) {
    return (
      <div className="flex items-center justify-between gap-3 bg-amber-50 px-4 py-2 text-sm text-amber-800">
        <span className="min-w-0">
          ⚠️ 저장하지 못했습니다 — 친 글은 화면에 그대로 있습니다.
          <span className="ml-1 text-xs text-amber-700">({saveFailed})</span>
        </span>
        <span className="flex shrink-0 gap-2">
          <button
            className="rounded bg-amber-600 px-2.5 py-1 text-xs text-white hover:bg-amber-500"
            onClick={saveCurrent}
          >
            다시 저장
          </button>
          {copyButton}
        </span>
      </div>
    );
  }

  return null;
}
