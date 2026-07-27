import { useEffect, useRef } from "react";

// 열려 있는 모달 스택 — Esc는 맨 위(가장 최근) 모달에만 적용해 중첩 모달이 한 번에 닫히지 않게 한다.
const modalStack: symbol[] = [];

/** 공통 모달 껍데기 — backdrop/Esc 닫기, 포커스 관리, 잠금(locked) 지원.
 *  패널의 모양(너비·모서리·패딩·그림자 등)은 panelClassName으로 그대로 넘긴다. */
export default function Modal({
  onClose,
  locked = false,
  align = "center",
  panelClassName = "w-[32rem] rounded-lg p-5 shadow-xl",
  children,
}: {
  onClose: () => void;
  /** true면 backdrop 클릭·Esc로 닫히지 않는다 (작업 진행 중 등) */
  locked?: boolean;
  /** 세로 정렬: 가운데(기본) 또는 위쪽(검색류) */
  align?: "center" | "top";
  /** 패널에 적용할 tailwind 클래스 (bg-white는 자동 부여) */
  panelClassName?: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const idRef = useRef<symbol>(Symbol("modal"));

  // 모달 스택 등록 (맨 위 모달만 Esc에 반응)
  useEffect(() => {
    const id = idRef.current;
    modalStack.push(id);
    return () => {
      const i = modalStack.indexOf(id);
      if (i !== -1) modalStack.splice(i, 1);
    };
  }, []);

  // Esc 닫기 (잠금 중이거나 맨 위 모달이 아니면 무시)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (locked) return;
      if (modalStack[modalStack.length - 1] !== idRef.current) return;
      e.stopPropagation();
      onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [locked, onClose]);

  // 열릴 때 패널로 포커스 (내부 autoFocus 요소가 있으면 그쪽이 우선 잡힌다)
  useEffect(() => {
    if (!panelRef.current?.contains(document.activeElement)) {
      panelRef.current?.focus();
    }
  }, []);

  return (
    <div
      className={`fixed inset-0 z-50 flex justify-center bg-black/30 ${
        align === "top" ? "items-start pt-24" : "items-center"
      }`}
      onClick={() => {
        if (!locked) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={`bg-white focus:outline-none ${panelClassName}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
