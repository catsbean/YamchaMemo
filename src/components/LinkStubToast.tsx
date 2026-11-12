import { MAX_LINK_STUBS } from "../lib/linkStubs";
import { useVault } from "../stores/vault";
import Toast from "./Toast";

/** 없는 글로 이어진 링크를 써서 자유노트에 글이 생겼을 때의 알림.
 *
 *  파일이 말없이 생기면 안 된다 — 무엇이 어디에 생겼는지 알리고, 오타였다면 그 자리에서
 *  [되돌리기]로 거둘 수 있어야 한다. 되돌리기는 그새 손댄 글은 건드리지 않는다.
 *
 *  너무 많아서(붙여 넣은 글에 링크가 잔뜩) 하나도 만들지 않았을 때도 여기서 알린다. */
export default function LinkStubToast() {
  const stubs = useVault((s) => s.linkStubs);
  const dismiss = useVault((s) => s.dismissLinkStubs);
  const undo = useVault((s) => s.undoLinkStubs);

  if (!stubs) return null;

  if (stubs.made.length === 0) {
    return (
      <Toast resetKey={stubs} onDone={dismiss}>
        <span className="text-neutral-300">
          없는 글로 이어진 링크가 {stubs.tooMany}개라 자동으로 만들지 않았습니다 (한 번에{" "}
          {MAX_LINK_STUBS}개까지). 링크를 눌러 하나씩 만들 수 있습니다.
        </span>
      </Toast>
    );
  }

  const first = stubs.made[0];
  return (
    <Toast
      resetKey={stubs}
      onDone={dismiss}
      action={{
        label: "되돌리기",
        title: "방금 만든 빈 글을 휴지통으로 보냅니다",
        onClick: undo,
      }}
    >
      <span className="font-medium">{first.target}</span>
      <span className="text-neutral-300">
        {stubs.made.length > 1 ? ` 외 ${stubs.made.length - 1}편을` : " 글을"} 자유노트에
        만들었습니다
      </span>
    </Toast>
  );
}
