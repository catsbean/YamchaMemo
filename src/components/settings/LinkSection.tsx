import { useVault } from "../../stores/vault";
import { SwitchRow } from "./ui";

/** `[[위키링크]]` 동작 설정. */
export default function LinkSection() {
  const createOnMissingLink = useVault((s) => s.createOnMissingLink);
  const setCreateOnMissingLink = useVault((s) => s.setCreateOnMissingLink);

  return (
    <SwitchRow
      title="없는 글을 링크하면 [만들기]"
      desc="아직 없는 글로 이어진 [[링크]]를 누르면 그 이름으로 바로 만들 수 있습니다. 끄면 알림만 잠깐 뜹니다."
      help={
        <>
          새 글은 보고 있던 분류에 만들어집니다(도서리스트·데일리노트에서는 자유노트). 같은 이름의 글이
          여럿이면 고르는 창이 뜹니다. 각 글의 [별칭] 칸에 다른 이름을 적어 두면 그 이름으로도 이어집니다.
        </>
      }
      checked={createOnMissingLink}
      onChange={setCreateOnMissingLink}
    />
  );
}
