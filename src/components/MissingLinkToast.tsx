import { useVault } from "../stores/vault";
import Toast from "./Toast";

/** 가리키는 글이 없는 `[[링크]]`를 눌렀을 때의 알림.
 *
 *  예전에는 전역 오류 토스트로 띄워서, ✕를 누르기 전까지 화면 구석에 계속 남았다.
 *  오타로 한 번 잘못 누른 것뿐인데 치우는 일까지 사람 몫이었다.
 *
 *  [만들기]는 그 이름으로 글을 만들어 곧바로 연다. 링크를 먼저 써 두고 나중에
 *  글을 채우는 흐름을 위해서다. 설정에서 끄면 알림만 뜬다. */
export default function MissingLinkToast() {
  const missingLink = useVault((s) => s.missingLink);
  const dismiss = useVault((s) => s.dismissMissingLink);
  const create = useVault((s) => s.createMissingLink);
  const canCreate = useVault((s) => s.createOnMissingLink);
  const schemas = useVault((s) => s.schemas);

  if (!missingLink) return null;
  const typeLabel =
    schemas.find((s) => s.id === missingLink.typeId)?.label ??
    missingLink.typeId;

  return (
    <Toast
      resetKey={missingLink}
      onDone={dismiss}
      action={
        canCreate
          ? {
              label: "만들기",
              title: `${typeLabel}에 이 이름으로 글을 만들고 엽니다`,
              onClick: create,
            }
          : undefined
      }
    >
      <span className="font-medium">{missingLink.target}</span>
      <span className="text-neutral-300"> — 아직 없는 글입니다</span>
    </Toast>
  );
}
