import { useVault } from "../../stores/vault";
import { SwitchRow } from "./ui";

/** 왼쪽 메뉴의 할 일 탭을 둘지 말지.
 *
 *  꺼도 할 일 자체는 그대로다 — 일지의 할 일 목록도, 홈의 할 일 카드도 남는다.
 *  없어지는 건 **여러 글에 흩어진 할 일을 모아 보는 자리**뿐이라, 일지 안에서만
 *  할 일을 쓰는 사람은 메뉴를 하나 줄일 수 있다. */
export default function TodoTabSection() {
  const todoTabOn = useVault((s) => s.todoTabOn);
  const setTodoTabOn = useVault((s) => s.setTodoTabOn);

  return (
    <SwitchRow
      title="할 일 탭"
      desc="왼쪽 메뉴에 [☑ 할 일]을 둡니다. 모든 글에 적힌 할 일을 한 자리에 모아 체크하거나 적힌 글로 갑니다."
      help="새 할 일은 오늘 일지에 담깁니다(오늘 일지가 없으면 만듭니다). 꺼도 이미 적어 둔 할 일은 그대로 남고, 일지와 홈에서 보입니다."
      checked={todoTabOn}
      onChange={setTodoTabOn}
    />
  );
}
