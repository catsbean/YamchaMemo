import { useVault } from "../../stores/vault";
import { SwitchRow } from "./ui";

/** 빠른 담기 — 전역 단축키로 작은 입력창 */
export default function QuickCaptureSection() {
  const { quickCaptureOn, setQuickCaptureOn, quickCaptureShortcut, setQuickCaptureShortcut, captureError } =
    useVault();

  return (
    <SwitchRow
      title="빠른 담기"
      desc="다른 프로그램을 쓰는 중에도 단축키 한 번으로 작은 입력창을 띄워 바로 담습니다."
      help={
        <>
          지금 떠오른 것이나 복사해 둔 것을 앱을 열지 않고 담습니다. 담긴 것은 오늘 일지에 한 줄로
          쌓입니다(오늘 일지가 없으면 만듭니다). 꺼 두면 단축키를 쓰지 않으므로 다른 프로그램의 단축키와
          부딪히지 않습니다.
        </>
      }
      checked={quickCaptureOn}
      onChange={setQuickCaptureOn}
    >
      <label className="flex items-center gap-2 text-xs text-neutral-600">
        단축키
        <input
          className="w-56 rounded border border-neutral-300 px-2 py-0.5 text-xs focus:border-neutral-500 focus:outline-none"
          value={quickCaptureShortcut}
          onChange={(e) => setQuickCaptureShortcut(e.target.value)}
        />
      </label>
      {captureError && <p className="mt-1.5 text-xs text-rose-600">{captureError}</p>}
    </SwitchRow>
  );
}
