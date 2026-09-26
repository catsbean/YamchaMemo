import Modal from "./Modal";
import { useRelocateProgress } from "../stores/vault";

/** 제목 바꾸기·옮기기가 오래 걸릴 때 띄우는 진행.
 *
 *  모두가 가리키는 노트면 수천 편의 링크를 고쳐 쓰고 다시 색인하느라 20초까지 걸린다.
 *  그동안 아무 표시가 없으면 앱이 멈춘 줄 안다. 두 단계라 단계와 그 단계의 %를 함께 보인다.
 *  닫을 수 없다(locked) — 도중에 다른 노트를 열어도 그 요청은 이 일이 끝날 때까지 기다린다
 *  (상태 잠금이 하나다). 헷갈리지 않게 막아 둔다. 금방 끝나는 흔한 경우엔 띄우지 않는다. */
export default function RelocateProgressDialog() {
  // 메인 스토어가 아니라 진행 전용 스토어를 구독한다 — 갱신마다 앱 전체가 다시 그려지지 않게
  const p = useRelocateProgress((s) => s.progress);
  if (!p) return null;

  const indexing = p.phase === "index";
  // 색인 단계의 마지막 한 칸은 색인 저장이다 — 편수에서는 뺀다
  const notes = indexing ? Math.max(p.total - 1, 0) : p.total;
  const done = Math.min(p.done, notes);
  const pct = p.total > 0 ? Math.floor((p.done * 100) / p.total) : 0;

  return (
    <Modal onClose={() => {}} locked panelClassName="w-80 rounded-lg p-5 shadow-xl">
      <div role="status" aria-live="polite">
        <p className="text-sm font-medium">
          {indexing ? "검색 색인을 정리하는 중" : "이 노트를 가리키는 링크를 고치는 중"}
          <span className="ml-1 text-neutral-400">({indexing ? 2 : 1}/2)</span>
        </p>
        <div
          className="mt-3 h-2 overflow-hidden rounded-full bg-neutral-200"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div
            className="h-full rounded-full bg-sky-500 transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-2 flex justify-between text-xs text-neutral-500 tabular-nums">
          <span>{notes > 0 ? `${done.toLocaleString()} / ${notes.toLocaleString()}편` : "준비 중"}</span>
          <span>{pct}%</span>
        </p>
        <p className="mt-3 text-xs text-neutral-500">
          이 노트를 가리키는 글이 많아 조금 걸립니다. 끝나면 저절로 닫힙니다.
        </p>
      </div>
    </Modal>
  );
}
