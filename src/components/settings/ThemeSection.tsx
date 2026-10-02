import { useVault } from "../../stores/vault";
import Segmented from "../Segmented";
import { Section } from "./ui";

/** 화면 밝기 — 라이트·다크·시스템 설정 */
export default function ThemeSection() {
  const { theme, setTheme } = useVault();

  return (
    <Section title="화면 밝기" desc="시스템 설정을 고르면 운영체제의 밝기를 따릅니다.">
      <Segmented
        value={theme}
        options={[
          ["light", "라이트"],
          ["dark", "다크"],
          ["system", "시스템 설정"],
        ]}
        onChange={setTheme}
      />
    </Section>
  );
}
