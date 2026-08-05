import { useMemo, useState } from "react";
import { styleOf } from "../lib/callouts";
import { useImeInput } from "../lib/ime";
import type { DailyKind } from "../bindings";
import { useVault } from "../stores/vault";
import WikiLinkSuggest from "./WikiLinkSuggest";

/** 기본 종류. 화면에 놓이는 순서는 설정(dailyKindOrder)이 정한다 */
const KINDS: {
  value: DailyKind;
  label: string;
  hint: string;
  active: string;
  idle: string;
  bar: string;
}[] = [
  {
    value: "todo",
    label: "할 일",
    hint: "할 일을 적고 [추가] 또는 Ctrl+Enter — 여러 줄이면 각각 항목이 됩니다",
    active: "bg-emerald-500 text-white",
    idle: "bg-white text-emerald-700 hover:bg-emerald-100",
    bar: "bg-emerald-50 border-emerald-200",
  },
  {
    value: "log",
    label: "기록",
    hint: "있었던 일을 적고 [추가] 또는 Ctrl+Enter — 기록에 시각과 함께 쌓입니다",
    active: "bg-sky-500 text-white",
    idle: "bg-white text-sky-700 hover:bg-sky-100",
    bar: "bg-sky-50 border-sky-200",
  },
  {
    value: "feeling",
    label: "느낌",
    hint: "지금 느낌을 적고 [추가] 또는 Ctrl+Enter — 기록에 시각과 함께 쌓입니다",
    active: "bg-amber-500 text-white",
    idle: "bg-white text-amber-700 hover:bg-amber-100",
    bar: "bg-amber-50 border-amber-200",
  },
];

/** 버튼 한 칸 — 기본 종류와 사용자 정의를 같은 모양으로 다룬다 */
export interface DailyKindOption {
  /** 기본 종류는 DailyKind 값, 사용자 정의는 그 이름 */
  key: string;
  label: string;
  icon?: string;
  hint: string;
  active: string;
  idle: string;
  bar: string;
}

/** 기본 종류 + 사용자 정의를 설정 순서대로 늘어놓는다.
 *  순서에 없는 종류(나중에 만든 것)는 뒤에 붙는다. */
export function dailyKindOptions(
  customs: { label: string; icon: string | null; color: string }[],
  order: string[],
): DailyKindOption[] {
  const options: DailyKindOption[] = [
    ...KINDS.map((k) => ({ key: k.value, ...k })),
    ...customs.map((c) => {
      const s = styleOf(c.color as never);
      return {
        key: c.label,
        label: c.label,
        icon: c.icon ?? undefined,
        hint: `${c.label} 내용을 적고 Ctrl+Enter`,
        active: s.active,
        idle: s.idle,
        bar: s.bar,
      };
    }),
  ];
  const rank = (k: string) => {
    const i = order.indexOf(k);
    return i === -1 ? order.length : i;
  };
  return options
    .map((o, i) => ({ o, i }))
    .sort((a, b) => rank(a.o.key) - rank(b.o.key) || a.i - b.i)
    .map(({ o }) => o);
}

/** 데일리노트 빠른 입력 바 — 할 일은 `## 할 일`에 체크박스로, 기록·느낌은 `## 기록`에 콜아웃으로.
 *  실제 추가는 창마다 상태 관리가 달라(메인=스토어, 노트 창=로컬 state) onSubmit으로 주입받는다. */
export default function DailyEntryBar({
  onSubmit,
}: {
  /** 기본 종류는 DailyKind 문자열, 사용자 정의는 그 이름이 그대로 온다 */
  onSubmit: (kind: string, text: string) => Promise<void>;
}) {
  // 고른 종류. 아직 안 골랐으면 맨 앞 버튼이 기본이다 (순서를 바꾸면 기본도 따라간다)
  const [picked, setPicked] = useState<string | null>(null);
  // 값은 DOM이 소유한다 (한글 조합 충돌 방지). 타이핑 중 setState가 없어야 하므로
  // 빈칸 여부도 상태로 두지 않는다 — 버튼은 늘 눌리고, 빈 값이면 submit이 무시한다.
  const [busy, setBusy] = useState(false);

  const callouts = useVault((s) => s.callouts);
  const order = useVault((s) => s.dailyKindOrder);
  const options = useMemo(
    () =>
      dailyKindOptions(
        callouts.filter((c) => c.scope === "daily" || c.scope === "both"),
        order,
      ),
    [callouts, order],
  );
  // 고른 종류가 사라졌으면(사용자 정의 제거 등) 맨 앞으로 되돌아간다
  const current = options.find((o) => o.key === picked) ?? options[0];
  const kind = current.key;
  const bar = current.bar;
  const activeCls = current.active;

  async function submit(value?: string) {
    const body = (value ?? ime.value()).trim();
    if (busy || !body) return;
    setBusy(true);
    try {
      await onSubmit(kind, body);
      ime.clear();
    } finally {
      setBusy(false);
    }
  }

  const ime = useImeInput<HTMLTextAreaElement>((v) => submit(v), "ctrl-enter");

  return (
    <div
      className={`flex flex-col gap-1.5 border-b px-4 py-2 transition-colors ${bar}`}
    >
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o.key}
            className={`rounded-md border border-current/10 px-3 py-1 text-sm font-medium transition-colors ${
              kind === o.key ? o.active : o.idle
            }`}
            onClick={() => setPicked(o.key)}
          >
            {o.icon ? `${o.icon} ` : ""}
            {o.label}
          </button>
        ))}
      </div>
      <div className="relative flex items-start gap-2">
        <textarea
          className="min-h-9 flex-1 resize-y rounded border border-neutral-300 bg-white px-2 py-1 text-sm focus:outline-none"
          placeholder={current.hint}
          defaultValue=""
          {...ime.handlers}
        />
        <WikiLinkSuggest inputRef={ime.handlers.ref} />
        <button
          className={`rounded px-3 py-1 text-sm text-white disabled:opacity-50 ${activeCls} hover:opacity-90`}
          disabled={busy}
          onClick={() => submit()}
        >
          추가
        </button>
      </div>
    </div>
  );
}
