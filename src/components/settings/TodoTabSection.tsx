import { useVault } from "../../stores/vault";

/** 왼쪽 메뉴의 할 일 탭을 둘지 말지.
 *
 *  꺼도 할 일 자체는 그대로다 — 일지의 할 일 목록도, 홈의 할 일 카드도 남는다.
 *  없어지는 건 **여러 글에 흩어진 할 일을 모아 보는 자리**뿐이라, 일지 안에서만
 *  할 일을 쓰는 사람은 메뉴를 하나 줄일 수 있다. */
export default function TodoTabSection() {
  const todoTabOn = useVault((s) => s.todoTabOn);
  const setTodoTabOn = useVault((s) => s.setTodoTabOn);

  return (
    <section className="mb-5">
      <h3 className="mb-2 text-sm font-semibold text-neutral-600">할 일 탭</h3>
      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={todoTabOn}
          onChange={(e) => setTodoTabOn(e.target.checked)}
        />
        <span>
          <span className="block">왼쪽 메뉴에 [☑ 할 일] 두기</span>
          <span className="block text-2xs text-neutral-400">
            모든 글에 적힌 할 일을 한 자리에 모아, 적힌 글로 가거나 그 자리에서
            체크합니다. 새 할 일은 오늘 일지에 담깁니다(오늘 일지가 없으면
            만듭니다). 꺼도 이미 적어 둔 할 일은 그대로 남고, 일지와 홈에서
            보입니다.
          </span>
        </span>
      </label>
    </section>
  );
}
