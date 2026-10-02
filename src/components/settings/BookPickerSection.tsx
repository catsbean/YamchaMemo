import { useVault } from "../../stores/vault";
import Segmented from "../Segmented";
import { Section } from "./ui";

/** 독서기록에서 책을 고르는 창의 모양 */
export default function BookPickerSection() {
  const { bookPickerView, setBookPickerView } = useVault();

  return (
    <Section title="책 고르기 창" desc="독서기록에 쓸 책을 고를 때 책을 어떻게 늘어놓을지 정합니다.">
      <Segmented
        value={bookPickerView}
        options={[
          ["grid", "책장(표지)"],
          ["list", "목록"],
        ]}
        onChange={setBookPickerView}
      />
    </Section>
  );
}
