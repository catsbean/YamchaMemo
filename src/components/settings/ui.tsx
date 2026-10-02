import { useEffect, useState, type ReactNode } from "react";
import Switch from "../Switch";

/** 설정 창의 공용 조각 (8-5) — 모든 섹션이 같은 모양을 쓴다.
 *
 *  섹션은 늘 **제목 · 한 줄 설명 · 조작** 순이다. 긴 설명은 제목 옆 `?`로 편다.
 *  고르는 모양은 셋뿐이다: 켜고 끄기는 `SwitchRow`, 하나 고르기는 `Segmented`, 보기마다 설명이
 *  필요한 고르기는 `RadioCards`. 되돌릴 수 없는 일은 `DangerButton`(한 번 더 묻는다). */

export function Section({
  title,
  desc,
  help,
  children,
}: {
  title: string;
  desc?: ReactNode;
  /** 제목 옆 `?`를 누르면 펼쳐지는 긴 설명 */
  help?: ReactNode;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="border-b border-neutral-100 py-4 first:pt-1 last:border-0">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-neutral-700">
        {title}
        {help && <HelpToggle open={open} onClick={() => setOpen((v) => !v)} />}
      </h3>
      {desc && <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">{desc}</p>}
      {help && open && (
        <div className="mt-2 rounded bg-neutral-50 p-2.5 text-xs leading-relaxed text-neutral-600">{help}</div>
      )}
      {children && <div className="mt-2.5">{children}</div>}
    </section>
  );
}

function HelpToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`flex h-4 w-4 items-center justify-center rounded-full border text-2xs ${
        open ? "border-neutral-500 text-neutral-700" : "border-neutral-300 text-neutral-500 hover:bg-neutral-100"
      }`}
      title={open ? "설명 접기" : "이게 무엇인지 보기"}
      aria-expanded={open}
      onClick={onClick}
    >
      ?
    </button>
  );
}

/** 켜고 끄기 한 줄 — 왼쪽에 이름과 설명, 오른쪽에 스위치. 섹션 하나가 통째로 이것일 때가 많다. */
export function SwitchRow({
  title,
  desc,
  checked,
  onChange,
  help,
  children,
}: {
  title: string;
  desc?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  help?: ReactNode;
  /** 켰을 때만 보이는 딸린 조작 (예: 빠른 담기의 단축키) */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="border-b border-neutral-100 py-4 first:pt-1 last:border-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-neutral-700">
            {title}
            {help && <HelpToggle open={open} onClick={() => setOpen((v) => !v)} />}
          </h3>
          {desc && <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">{desc}</p>}
        </div>
        <span className="pt-0.5">
          <Switch checked={checked} onChange={onChange} label={title} />
        </span>
      </div>
      {help && open && (
        <div className="mt-2 rounded bg-neutral-50 p-2.5 text-xs leading-relaxed text-neutral-600">{help}</div>
      )}
      {checked && children && <div className="mt-2.5">{children}</div>}
    </section>
  );
}

/** 보기마다 설명이 필요한 하나 고르기 */
export function RadioCards<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string; desc: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-3">
      {options.map((o) => (
        <label
          key={o.value}
          className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 ${
            value === o.value ? "border-neutral-800 bg-neutral-50" : "border-neutral-200 hover:border-neutral-400"
          }`}
        >
          <input type="radio" className="mt-1" checked={value === o.value} onChange={() => onChange(o.value)} />
          <span className="min-w-0">
            <span className="block text-sm font-medium">{o.label}</span>
            <span className="block text-xs text-neutral-500">{o.desc}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** 되돌릴 수 없는 일 — 누르면 한 번 더 묻는다. 묻는 동안 5초 안에 안 누르면 거둔다. */
export function DangerButton({
  label,
  confirmLabel,
  note,
  busy = false,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  /** 확인을 물을 때 곁에 보일 한 줄 (무엇이 사라지는지) */
  note?: string;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const t = setTimeout(() => setAsking(false), 5000);
    return () => clearTimeout(t);
  }, [asking]);

  if (!asking) {
    return (
      <button
        type="button"
        className="rounded border border-rose-200 px-3 py-1 text-xs text-rose-600 hover:border-rose-400 hover:bg-rose-50 disabled:opacity-40"
        disabled={busy}
        onClick={() => setAsking(true)}
      >
        {label}
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {note && <span className="text-xs text-rose-600">{note}</span>}
      <button
        type="button"
        className="rounded bg-rose-600 px-3 py-1 text-xs font-medium text-white hover:bg-rose-500 disabled:opacity-50"
        disabled={busy}
        onClick={async () => {
          setAsking(false);
          await onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
        onClick={() => setAsking(false)}
      >
        취소
      </button>
    </span>
  );
}
