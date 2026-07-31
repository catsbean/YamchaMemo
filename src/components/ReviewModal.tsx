import Modal from "./Modal";
import ReviewDashboard from "./ReviewDashboard";

/** 회고를 일지 목록에서 바로 여는 팝업.
 *
 *  사이드바의 별도 메뉴가 아니라 여기 있는 이유 — 회고는 "일지를 모아 보는 일"이라
 *  일지 목록에서 펼치는 것이 자연스럽다. 메뉴를 하나 줄이는 값도 있다.
 *
 *  크기는 화면을 넉넉히 쓰되 가장자리를 남긴다. 꽉 채우면 팝업인지
 *  화면이 바뀐 것인지 구분이 안 된다.
 *  세로로 넉넉히 쓰려고 align은 center다 — top은 Modal이 pt-24(6rem)를 얹어
 *  그만큼 높이를 못 쓴다. */
export default function ReviewModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      onClose={onClose}
      panelClassName="flex h-[calc(100vh-4rem)] w-[min(1500px,95vw)] flex-col overflow-hidden rounded-xl shadow-2xl"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-5 py-3">
        <h2 className="text-base font-bold text-neutral-900">🔭 회고</h2>
        <span className="text-xs text-neutral-400">
          주간·월간으로 기록과 할 일을 모아 봅니다
        </span>
        {/* 닫는 곳은 한 군데만 둔다. 위아래 둘이면 어느 것을 눌러야 할지 고민하게 된다 */}
        <button
          className="ml-auto rounded border border-neutral-300 px-4 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
          onClick={onClose}
          title="닫기 (Esc)"
        >
          닫기
        </button>
      </header>

      {/* 회고 본체는 그대로 쓴다 — 사이드바에서 보던 것과 같은 화면이다 */}
      <div className="min-h-0 flex-1 overflow-y-auto text-neutral-900">
        <ReviewDashboard />
      </div>
    </Modal>
  );
}
