import { useVault, type LayoutMode } from "../../stores/vault";
import { RadioCards, Section } from "./ui";

const LAYOUTS: { value: LayoutMode; label: string; desc: string }[] = [
  { value: "three", label: "3단 보기", desc: "메뉴 · 목록 · 편집기를 나란히" },
  { value: "vertical", label: "상하 분할", desc: "목록은 위, 편집기는 아래" },
  { value: "replace", label: "전체 전환", desc: "편집기만 (← 버튼으로 목록)" },
];

/** 편집 시 목록 표시 — 3단·상하·전체 전환 */
export default function LayoutSection() {
  const { layout, setLayout } = useVault();

  return (
    <Section title="편집 시 목록 표시" desc="노트를 열었을 때 목록을 어디에 둘지 고릅니다.">
      <RadioCards value={layout} options={LAYOUTS} onChange={setLayout} />
    </Section>
  );
}
