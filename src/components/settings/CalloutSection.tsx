import { useState } from "react";
import { commands } from "../../bindings";
import {
  useVault,
} from "../../stores/vault";
import { styleOf } from "../../lib/callouts";
import { useImeInput } from "../../lib/ime";

const PALETTE = [
  "red", "orange", "yellow", "lime", "emerald",
  "sky", "indigo", "violet", "rose", "neutral", "black",
] as const;

const PALETTE_LABEL: Record<string, string> = {
  red: "빨강", orange: "주황", yellow: "노랑", lime: "연두",
  emerald: "초록", sky: "하늘", indigo: "남색", violet: "보라",
  rose: "분홍", neutral: "회색", black: "검정",
  // 아래는 기본 콜아웃·기존 설정이 쓰던 색 (새로 고를 수는 없다)
  amber: "호박", teal: "청록", blue: "파랑", fuchsia: "자주", stone: "갈회",
};

// 문장처럼 읽히도록: "[데일리노트에] [아이콘] [이름] 추가"
const SCOPES: [string, string][] = [
  ["daily", "데일리노트에"],
  ["book", "독서기록에"],
  ["both", "둘 다에"],
];

/** 목록에 짧게 표시할 이름 */
const SCOPE_SHORT: Record<string, string> = {
  daily: "데일리노트",
  book: "독서기록",
  both: "둘 다",
};

/** 고를 수 있는 아이콘 (맨 앞은 '없음') */
const ICONS = [
  "",
  "📌","💭","📋","❓","🕘","💛","🔖","⭐","✅","📖",
  "✍️","💡","🔥","🌱","🎯","🧩","📎","🗒️","🔔","💬",
  "📝","🗓️","⏰","🏷️","🔍","📊","📈","🧠","🫀","👍",
  "👎","⚠️","❗","‼️","❤️","🧡","💚","💙","💜","🤍",
  "🌟","✨","🌈","☀️","🌙","☁️","🌊","🍀","🌸","🍂",
  "🎵","🎬","🎨","🏃","🍽️","☕","🛏️","💊","💰","🎁",
]; 

/** 사용자 정의 콜아웃 — 일지·책 각각 5개까지 */
export default function CalloutSection() {
  const { callouts, refreshCallouts } = useVault();
  const [icon, setIcon] = useState("");
  const [color, setColor] = useState<string>("rose");
  const [scope, setScope] = useState("daily");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  async function add(value?: string) {
    const name = (value ?? addIme.value()).trim();
    if (busy || !name) return;
    setBusy(true);
    setError("");
    const r = await commands.addCallout({
      label: name,
      icon,
      color,
      scope,
    });
    if (r.status === "ok") {
      addIme.clear();
      await refreshCallouts();
    } else {
      setError(r.error);
    }
    setBusy(false);
  }

  const addIme = useImeInput((v) => add(v), "enter");

  async function remove(l: string) {
    setBusy(true);
    setConfirming(null);
    const r = await commands.removeCallout(l);
    if (r.status === "ok") await refreshCallouts();
    else setError(r.error);
    setBusy(false);
  }

  return (
    <section className="mb-5">
      <h3 className="mb-1 text-sm font-semibold text-neutral-600">기록 종류 추가</h3>
      <p className="mb-2 text-xs text-neutral-400">
        일지·책에서 쓸 기록 종류를 직접 만들 수 있습니다. 화면마다 5개까지이고,
        만든 종류는 vault에 저장돼 다른 기기에서도 그대로 보입니다.
      </p>

      {callouts.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1">
          {callouts.map((c) => (
            <li
              key={c.label}
              className={`flex items-center justify-between rounded border px-3 py-1.5 text-xs ${styleOf(
                c.color as never,
              ).card}`}
            >
              <span>
                {c.icon && `${c.icon} `}
                {c.label}
                <span className="ml-2 opacity-60">
                  {SCOPE_SHORT[c.scope] ?? c.scope} ·{" "}
                  {PALETTE_LABEL[c.color] ?? c.color}
                </span>
              </span>
              {confirming === c.label ? (
                <span className="flex shrink-0 items-center gap-1">
                  <span className="text-3xs opacity-70">
                    이미 쓴 기록은 남습니다
                  </span>
                  <button
                    className="rounded bg-rose-600 px-1.5 py-0.5 text-2xs font-bold text-white hover:bg-rose-500 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => remove(c.label)}
                  >
                    제거 확인
                  </button>
                  <button
                    className="rounded px-1 py-0.5 text-2xs opacity-70 hover:bg-white/60"
                    onClick={() => setConfirming(null)}
                  >
                    취소
                  </button>
                </span>
              ) : (
                <button
                  className="shrink-0 text-rose-400 hover:text-rose-600 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => setConfirming(c.label)}
                  title="목록에서만 뺍니다 — 이미 쓴 기록은 그대로 남습니다"
                >
                  제거
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <select
          className="rounded border border-neutral-300 px-1.5 py-1 text-xs"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          {SCOPES.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>

        {/* 아이콘: 지금 고른 것만 보여주고 누르면 펼친다 */}
        <div className="relative">
          <button
            className="h-7 w-10 rounded border border-neutral-300 text-sm hover:border-neutral-500"
            onClick={() => {
              setIconOpen((v) => !v);
              setColorOpen(false);
            }}
            title="아이콘 고르기"
          >
            {icon || <span className="text-3xs text-neutral-400">없음</span>}
          </button>
          {iconOpen && (
            <div className="absolute left-0 z-10 mt-1 flex max-h-56 w-[17rem] flex-wrap gap-1 overflow-y-auto rounded-md border border-neutral-200 bg-white p-2 shadow-lg">
              {ICONS.map((ic) => (
                <button
                  key={ic || "none"}
                  className={`h-7 w-7 rounded border text-sm ${
                    icon === ic
                      ? "border-neutral-800 bg-neutral-100"
                      : "border-transparent hover:border-neutral-300"
                  }`}
                  onClick={() => {
                    setIcon(ic);
                    setIconOpen(false);
                  }}
                  title={ic || "없음"}
                >
                  {ic || <span className="text-3xs text-neutral-400">없음</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <input
          className="w-24 rounded border border-neutral-300 px-2 py-1 text-sm focus:border-neutral-500 focus:outline-none"
          placeholder="이름"
          defaultValue=""
          {...addIme.handlers}
        />

        {/* 색: 지금 고른 색만 보여주고 누르면 펼친다 */}
        <div className="relative">
          <button
            className={`rounded border px-2.5 py-1 text-xs ${styleOf(color as never).card}`}
            onClick={() => {
              setColorOpen((v) => !v);
              setIconOpen(false);
            }}
            title="색 고르기"
          >
            {PALETTE_LABEL[color] ?? color}
          </button>
          {colorOpen && (
            <div className="absolute right-0 z-10 mt-1 grid w-[17rem] grid-cols-3 gap-1 rounded-md border border-neutral-200 bg-white p-2 shadow-lg">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  className={`rounded border px-2 py-1 text-center text-xs ${styleOf(c).card} ${
                    color === c ? "ring-2 ring-neutral-800" : ""
                  }`}
                  onClick={() => {
                    setColor(c);
                    setColorOpen(false);
                  }}
                >
                  {PALETTE_LABEL[c] ?? c}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          className="rounded bg-neutral-800 px-3 py-1 text-xs text-white hover:bg-neutral-600 disabled:opacity-50"
          disabled={busy}
          onClick={() => add()}
        >
          추가
        </button>
      </div>
      {error && <p className="mt-1.5 text-xs text-rose-500">{error}</p>}
    </section>
  );
}
