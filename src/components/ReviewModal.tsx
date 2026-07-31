import Modal from "./Modal";
import ReviewDashboard from "./ReviewDashboard";

/** 회고를 일지 옆에서 바로 여는 팝업.
 *
 *  사이드바의 별도 메뉴가 아니라 여기 있는 이유 — 회고는 "일지를 모아 보는 일"이라
 *  일지를 보다가 펼치는 것이 자연스럽다. 메뉴를 하나 줄이는 값도 있다.
 *
 *  크기는 화면의 대부분을 쓰되 가장자리를 남긴다. 꽉 채우면 팝업인지
 *  화면이 바뀐 것인지 구분이 안 된다.
 *  높이는 `100vh - 8rem`이다 — Modal이 align="top"에 pt-24(6rem)를 이미 주므로
 *  거기에 여백을 더 얹으면 아래쪽 닫기 버튼이 화면 밖으로 밀린다. */
export default function ReviewModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      onClose={onClose}
      align="top"
      panelClassName="flex h-[calc(100vh-8rem)] w-[min(1100px,92vw)] flex-col overflow-hidden rounded-xl shadow-2xl"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-5 py-3">
        <h2 className="text-base font-bold text-neutral-900">🔭 회고</h2>
        <span className="text-xs text-neutral-400">
          주간·월간으로 기록과 할 일을 모아 봅니다
        </span>
        <button
          className="ml-auto rounded px-2 py-0.5 text-sm text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
          onClick={onClose}
          title="닫기 (Esc)"
          aria-label="회고 닫기"
        >
          ✕
        </button>
      </header>

      {/* 회고 본체는 그대로 쓴다 — 사이드바에서 보던 것과 같은 화면이다 */}
      <div className="min-h-0 flex-1 overflow-y-auto text-neutral-900">
        <ReviewDashboard />
      </div>

      <footer className="flex shrink-0 justify-end border-t border-neutral-200 px-5 py-2">
        <button
          className="rounded border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
          onClick={onClose}
        >
          닫기
        </button>
      </footer>
    </Modal>
  );
}
