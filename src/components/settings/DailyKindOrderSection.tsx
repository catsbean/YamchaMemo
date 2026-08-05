import { useMemo } from "react";
import {
  DEFAULT_DAILY_KIND_ORDER,
  useVault,
} from "../../stores/vault";
import { dailyKindOptions } from "../DailyEntryBar";

/** 일지 빠른 입력 바의 버튼 순서 — ▲▼로 바꾸면 그 자리에서 저장된다.
 *  맨 앞에 둔 종류가 일지를 열었을 때 기본으로 선택된다. */
export default function DailyKindOrderSection() {
  const callouts = useVault((s) => s.callouts);
  const order = useVault((s) => s.dailyKindOrder);
  const setDailyKindOrder = useVault((s) => s.setDailyKindOrder);

  const options = useMemo(
    () =>
      dailyKindOptions(
        callouts.filter((c) => c.scope === "daily" || c.scope === "both"),
        order,
      ),
    [callouts, order],
  );

  /** 화면에 보이는 순서를 그대로 저장한다 (지금 없는 종류는 목록에서 빠진다) */
  function move(index: number, delta: -1 | 1) {
    const next = options.map((o) => o.key);
    const to = index + delta;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    setDailyKindOrder(next);
  }

  const isDefault =
    options.map((o) => o.key).join() ===
    dailyKindOptions(
      callouts.filter((c) => c.scope === "daily" || c.scope === "both"),
      DEFAULT_DAILY_KIND_ORDER,
    )
      .map((o) => o.key)
      .join();

  return (
    <section className="mb-5">
      <h3 className="mb-1 text-sm font-semibold text-neutral-600">
        일지 빠른 입력 순서
      </h3>
      <p className="mb-2 text-xs text-neutral-400">
        데일리노트 입력 바의 버튼 순서입니다. 맨 위에 둔 종류가 기본으로
        선택됩니다.
      </p>
      <ul className="flex flex-col gap-1">
        {options.map((o, i) => (
          <li key={o.key} className="flex items-center gap-1.5">
            <span
              className={`min-w-20 rounded-md border border-current/10 px-3 py-1 text-center text-sm font-medium ${o.active}`}
            >
              {o.icon ? `${o.icon} ` : ""}
              {o.label}
            </span>
            <button
              className="rounded border border-neutral-300 px-1.5 py-0.5 text-xs text-neutral-600 hover:border-neutral-500 disabled:opacity-30"
              disabled={i === 0}
              onClick={() => move(i, -1)}
              title="위로"
            >
              ▲
            </button>
            <button
              className="rounded border border-neutral-300 px-1.5 py-0.5 text-xs text-neutral-600 hover:border-neutral-500 disabled:opacity-30"
              disabled={i === options.length - 1}
              onClick={() => move(i, 1)}
              title="아래로"
            >
              ▼
            </button>
          </li>
        ))}
      </ul>
      {!isDefault && (
        <button
          className="mt-2 rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 hover:border-neutral-500"
          onClick={() => setDailyKindOrder(DEFAULT_DAILY_KIND_ORDER)}
        >
          기본 순서로
        </button>
      )}
    </section>
  );
}
