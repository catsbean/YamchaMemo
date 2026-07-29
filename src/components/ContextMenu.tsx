import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MenuItem, MenuState } from "../lib/contextMenu";

/** 앱 공용 우클릭 메뉴. 화면 밖으로 나가면 안쪽으로 접어 넣는다. */
export default function ContextMenu({
  state,
  onClose,
}: {
  state: MenuState;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y });

  // 화면 경계 보정 (오른쪽·아래로 넘칠 때)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    setPos({
      x: Math.min(state.x, window.innerWidth - width - pad),
      y: Math.min(state.y, window.innerHeight - height - pad),
    });
  }, [state.x, state.y]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    // capture 단계에서 잡아야 다른 핸들러보다 먼저 닫힌다
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[100] min-w-44 rounded-lg border border-neutral-200 bg-white py-1 shadow-xl"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {state.items.map((item, i) =>
        item.separator ? (
          <div key={i} className="my-1 border-t border-neutral-100" />
        ) : (
          <Row key={i} item={item} onClose={onClose} />
        ),
      )}
    </div>
  );
}

function Row({ item, onClose }: { item: MenuItem; onClose: () => void }) {
  return (
    <button
      role="menuitem"
      disabled={item.disabled}
      className={`flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm disabled:opacity-35 ${
        item.danger
          ? "text-rose-600 hover:bg-rose-50"
          : "text-neutral-700 hover:bg-neutral-100"
      } disabled:hover:bg-transparent`}
      onClick={() => {
        onClose();
        item.onClick?.();
      }}
    >
      <span className="flex-1 truncate">{item.label}</span>
      {item.hint && (
        <span className="shrink-0 text-2xs text-neutral-400">{item.hint}</span>
      )}
    </button>
  );
}
