/** 켜고 끄기 — 앱 전체가 같은 모양을 쓴다 (검색창의 토글, 설정의 켜기/끄기).
 *
 *  6단계에서 검색창 토글을 체크박스·칩에서 스위치로 바꿨다 — 분류 칩과 구분이 안 돼 켜고 끄는
 *  것인지 알 수 없었다. 그 손잡이를 여기 한 곳에 둔다. */

/** 손잡이가 움직이는 트랙만 — 다른 단추 안에 넣어 쓴다(검색창 토글) */
export function SwitchTrack({ on, tone = "light" }: { on: boolean; tone?: "light" | "onColor" }) {
  const track = tone === "onColor" ? (on ? "bg-white/40" : "bg-neutral-300") : on ? "bg-sky-600" : "bg-neutral-300";
  return (
    <span className={`relative inline-block h-3 w-6 shrink-0 rounded-full transition-colors ${track}`}>
      <span
        className={`absolute top-0.5 h-2 w-2 rounded-full bg-white transition-all ${on ? "left-3.5" : "left-0.5"}`}
      />
    </span>
  );
}

/** 혼자 서는 스위치 — 이름표는 옆에 따로 둔다(`label`은 화면 읽기용) */
export default function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${
        checked ? "bg-sky-600" : "bg-neutral-300"
      }`}
    >
      <span
        className={`absolute h-4 w-4 rounded-full bg-white shadow-sm transition-all ${checked ? "left-[1.125rem]" : "left-0.5"}`}
      />
    </button>
  );
}
