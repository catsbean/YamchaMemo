import { useEffect, useState } from "react";

/** 알림이 스스로 사라지기까지 (ms) */
const LIFETIME = 6000;

/** 화면 오른쪽 아래에 잠깐 떴다 사라지는 알림.
 *
 *  ✕를 눌러야만 없어지는 알림은 치우는 일까지 사람 몫으로 넘긴다. 스스로 물러나되,
 *  **마우스를 올려 두는 동안은 기다린다** — 버튼을 누르러 가는 중인데 사라지면
 *  그것대로 곤란하다. `resetKey`가 바뀌면 수명을 처음부터 다시 잰다(같은 알림이
 *  다시 떴을 때 남은 시간만 보여 주지 않도록). */
export default function Toast({
  resetKey,
  onDone,
  lifetime = LIFETIME,
  children,
  action,
}: {
  /** 이 값이 달라지면 수명을 처음부터 다시 잰다.
   *  같은 내용이 다시 떴을 때도 새로 세도록 대개 알림 객체 자체를 넘긴다. */
  resetKey: unknown;
  onDone: () => void;
  lifetime?: number;
  children: React.ReactNode;
  /** 오른쪽에 붙는 버튼 (없으면 안 붙는다) */
  action?: { label: string; title?: string; onClick: () => void };
}) {
  const [hovering, setHovering] = useState(false);

  useEffect(() => {
    if (hovering) return;
    const t = setTimeout(onDone, lifetime);
    return () => clearTimeout(t);
  }, [resetKey, hovering, lifetime, onDone]);

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex max-w-md items-center gap-3 rounded-lg bg-neutral-800 px-4 py-2 text-sm text-white shadow-lg"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <span className="min-w-0">{children}</span>
      {action && (
        <button
          className="shrink-0 rounded bg-white px-2.5 py-1 text-xs font-medium text-neutral-800 hover:bg-neutral-200"
          onClick={action.onClick}
          title={action.title}
        >
          {action.label}
        </button>
      )}
      <button
        className="shrink-0 text-neutral-400 hover:text-white"
        onClick={onDone}
        title="닫기"
      >
        ✕
      </button>
    </div>
  );
}
