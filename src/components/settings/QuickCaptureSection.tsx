import { useState } from "react";
import { useVault } from "../../stores/vault";

/** 빠른 담기 — 전역 단축키로 작은 입력창 */
export default function QuickCaptureSection() {
  const { quickCaptureOn, setQuickCaptureOn, quickCaptureShortcut, setQuickCaptureShortcut, captureError } =
    useVault();
  const [captureHelp, setCaptureHelp] = useState(false);

  return (
    <section className="mb-5">
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-neutral-600">
        빠른 담기
        <button
          className="flex h-4 w-4 items-center justify-center rounded-full border border-neutral-300 text-2xs text-neutral-500 hover:bg-neutral-100"
          title="이 기능이 무엇인지 보기"
          onClick={() => setCaptureHelp((v) => !v)}
        >
          ?
        </button>
      </h3>
      {captureHelp && (
        <p className="mb-2 rounded bg-neutral-50 p-2.5 text-xs leading-relaxed text-neutral-600">
          다른 프로그램을 쓰는 중에도 단축키 한 번으로 작은 입력창을 띄워, 지금
          떠오른 것이나 복사해 둔 것을 앱을 열지 않고 바로 담습니다. 담긴 것은
          아래에서 고른 곳에 한 줄로 쌓입니다.
          <br />
          꺼 두면 단축키를 쓰지 않으므로 다른 프로그램의 단축키와 부딪히지 않습니다.
        </p>
      )}
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={quickCaptureOn}
          onChange={(e) => setQuickCaptureOn(e.target.checked)}
        />
        <span>단축키로 어디서든 담기</span>
      </label>
      {captureError && (
        <p className="mt-1.5 text-xs text-rose-600">{captureError}</p>
      )}
      {quickCaptureOn && (
        <div className="mt-2 space-y-2 pl-6">
          <label className="flex items-center gap-2 text-xs text-neutral-600">
            단축키
            <input
              className="w-56 rounded border border-neutral-300 px-2 py-0.5 text-xs focus:border-neutral-500 focus:outline-none"
              value={quickCaptureShortcut}
              onChange={(e) => setQuickCaptureShortcut(e.target.value)}
            />
          </label>
        </div>
      )}
    </section>
  );
}
