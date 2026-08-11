import { useVault } from "../../stores/vault";

/** `[[위키링크]]` 동작 설정.
 *
 *  지금은 항목이 하나뿐이지만 따로 둔 이유는, 링크 규칙(별칭·중복 이름·없는 글)이
 *  한 덩어리라서다 — 나중에 늘어나도 사용자가 같은 자리에서 찾는다. */
export default function LinkSection() {
  const createOnMissingLink = useVault((s) => s.createOnMissingLink);
  const setCreateOnMissingLink = useVault((s) => s.setCreateOnMissingLink);

  return (
    <section className="mb-5">
      <h3 className="mb-2 text-sm font-semibold text-neutral-600">
        위키링크 [[ ]]
      </h3>
      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={createOnMissingLink}
          onChange={(e) => setCreateOnMissingLink(e.target.checked)}
        />
        <span>
          <span className="block">없는 글을 링크했을 때 [만들기] 보여주기</span>
          <span className="block text-2xs text-neutral-400">
            아직 없는 글로 이어진 링크를 누르면 그 이름으로 바로 만들 수 있습니다.
            새 글은 보고 있던 분류에 만들어집니다(도서리스트·데일리노트에서는
            자유노트). 꺼 두면 알림만 잠깐 뜹니다.
          </span>
        </span>
      </label>
      <p className="mt-2 text-2xs text-neutral-400">
        같은 이름의 글이 여럿이면 고르는 창이 뜹니다. 각 글의 [별칭] 칸에 다른
        이름을 적어 두면 그 이름으로도 이어집니다.
      </p>
    </section>
  );
}
