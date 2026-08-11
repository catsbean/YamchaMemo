import { useEffect, useState } from "react";
import { useVault } from "../stores/vault";

/** 알림이 스스로 사라지기까지 (ms) */
const LIFETIME = 6000;

/** 가리키는 글이 없는 `[[링크]]`를 눌렀을 때의 알림.
 *
 *  예전에는 전역 오류 토스트로 띄워서, ✕를 누르기 전까지 화면 구석에 계속 남았다.
 *  오타로 한 번 잘못 누른 것뿐인데 치우는 일까지 사람 몫이었다. 잠깐 알리고
 *  스스로 물러난다 — 마우스를 올려 두는 동안은 기다린다(버튼을 누르러 가는 중이다).
 *
 *  [만들기]는 그 이름으로 글을 만들어 곧바로 연다. 링크를 먼저 써 두고 나중에
 *  글을 채우는 흐름을 위해서다. 설정에서 끄면 알림만 뜬다. */
export default function MissingLinkToast() {
  const missingLink = useVault((s) => s.missingLink);
  const dismiss = useVault((s) => s.dismissMissingLink);
  const create = useVault((s) => s.createMissingLink);
  const canCreate = useVault((s) => s.createOnMissingLink);
  const schemas = useVault((s) => s.schemas);
  const [hovering, setHovering] = useState(false);

  useEffect(() => {
    if (!missingLink || hovering) return;
    const t = setTimeout(dismiss, LIFETIME);
    return () => clearTimeout(t);
  }, [missingLink, hovering, dismiss]);

  if (!missingLink) return null;
  const typeLabel =
    schemas.find((s) => s.id === missingLink.typeId)?.label ??
    missingLink.typeId;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex max-w-md items-center gap-3 rounded-lg bg-neutral-800 px-4 py-2 text-sm text-white shadow-lg"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <span className="min-w-0">
        <span className="font-medium">{missingLink.target}</span>
        <span className="text-neutral-300"> — 아직 없는 글입니다</span>
      </span>
      {canCreate && (
        <button
          className="shrink-0 rounded bg-white px-2.5 py-1 text-xs font-medium text-neutral-800 hover:bg-neutral-200"
          onClick={create}
          title={`${typeLabel}에 이 이름으로 글을 만들고 엽니다`}
        >
          만들기
        </button>
      )}
      <button
        className="shrink-0 text-neutral-400 hover:text-white"
        onClick={dismiss}
        title="닫기"
      >
        ✕
      </button>
    </div>
  );
}
