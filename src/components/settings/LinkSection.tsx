import { useVault } from "../../stores/vault";
import { SwitchRow } from "./ui";

/** `[[위키링크]]` 동작 설정.
 *
 *  만들기 스위치가 둘인 까닭: 하나는 **쓰는 순간**, 하나는 **누르는 순간**이다. 자동 만들기를 꺼도
 *  예전에 써 둔 링크나 폴더까지 적은 링크는 누를 때 만들 수 있어야 한다. */
export default function LinkSection() {
  const autoCreate = useVault((s) => s.autoCreateLinkTargets);
  const setAutoCreate = useVault((s) => s.setAutoCreateLinkTargets);
  const suggestPlain = useVault((s) => s.suggestLinksWhileTyping);
  const setSuggestPlain = useVault((s) => s.setSuggestLinksWhileTyping);
  const createOnMissingLink = useVault((s) => s.createOnMissingLink);
  const setCreateOnMissingLink = useVault((s) => s.setCreateOnMissingLink);

  return (
    <>
      <SwitchRow
        title="없는 글을 링크하면 자동으로 만들기"
        desc="아직 없는 글의 이름으로 [[링크]]를 쓰면 그 이름의 빈 글이 자유노트에 생깁니다."
        help={
          <>
            링크를 다 쓰고 커서가 벗어난 뒤, 저장될 때 만들어집니다(쓰던 글은 그대로 열려 있습니다).
            알림의 [되돌리기]로 거둘 수 있고, 링크를 고치거나 지워 아무도 가리키지 않게 된 빈 글은
            저절로 휴지통으로 갑니다 — 한 글자라도 쓴 글은 건드리지 않습니다. 이미 써 둔 링크,
            날짜 모양(2026-11-12), 폴더까지 적은 링크([[회의록/이름]])로는 만들지 않습니다.
          </>
        }
        checked={autoCreate}
        onChange={setAutoCreate}
      />
      <SwitchRow
        title="없는 글의 링크를 누르면 [만들기]"
        desc="아직 없는 글로 이어진 [[링크]]를 누르면 그 이름으로 바로 만들 수 있습니다. 끄면 알림만 잠깐 뜹니다."
        help={
          <>
            새 글은 자유노트에 만들어집니다. 같은 이름의 글이 여럿이면 고르는 창이 뜹니다. 각 글의
            [별칭] 칸에 다른 이름을 적어 두면 그 이름으로도 이어집니다.
          </>
        }
        checked={createOnMissingLink}
        onChange={setCreateOnMissingLink}
      />
      <SwitchRow
        title="글 이름을 치면 링크 추천"
        desc="[[ 를 치지 않아도, 쓰다가 있는 글의 이름이 나오면 링크로 바꿀지 추천합니다."
        help={
          <>
            목록이 떠도 아무것도 골라져 있지 않아 Enter는 그대로 줄바꿈입니다. ↓나 Tab을 눌러야 고르기가
            시작되고, 그다음 Enter(또는 Tab)가 그 낱말을 [[링크]]로 바꿉니다. 낱말의 앞부터 두 글자 이상
            맞을 때만 뜨고, 조사가 붙어 이름보다 길어지면 닫힙니다. 코드·주소·제목 줄·이미 링크인 자리,
            그리고 일지(날짜 이름)는 추천하지 않습니다.
          </>
        }
        checked={suggestPlain}
        onChange={setSuggestPlain}
      />
    </>
  );
}
