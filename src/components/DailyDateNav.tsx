import { useMemo, useState } from "react";
import { useVault } from "../stores/vault";
import { dateOf, isYmd, pad, WEEK, weekdayOf, ymd } from "../lib/date";

/** 일지 노트 제목 자리에 놓이는 날짜 이동기.
 *
 *  `◀ ▶`는 **있는 일지만** 오간다 — 안 쓴 날은 건너뛴다. 화살표를 누르다
 *  빈 일지가 줄줄이 생기는 걸 막기 위해서다. 달력에서 고른 날짜는 없으면 만든다. */
export default function DailyDateNav({ date }: { date: string }) {
  const notes = useVault((s) => s.notes);
  const openNote = useVault((s) => s.openNote);
  const openDailyDate = useVault((s) => s.openDailyDate);
  const openToday = useVault((s) => s.openToday);
  const [calendar, setCalendar] = useState(false);

  /** 있는 일지들의 날짜 → 경로 (오름차순) */
  const days = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of notes) {
      if (n.note_type !== "daily") continue;
      const d = dateOf(n.rel_path);
      if (isYmd(d)) map.set(d, n.rel_path);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [notes]);

  const at = days.findIndex(([d]) => d === date);
  const prev = at > 0 ? days[at - 1] : null;
  const next = at >= 0 && at < days.length - 1 ? days[at + 1] : null;
  const today = ymd(new Date());
  const isToday = date === today;

  const weekday = weekdayOf(date);

  return (
    <span className="relative flex items-center gap-1">
      <Arrow
        label={prev ? `${prev[0]}로` : "이전 일지 없음"}
        disabled={!prev}
        onClick={() => prev && openNote(prev[1])}
      >
        ◀
      </Arrow>

      <button
        className="rounded px-1.5 py-0.5 text-base font-bold hover:bg-neutral-100"
        onClick={() => setCalendar((v) => !v)}
        title="달력에서 날짜 고르기"
      >
        {date}
        {weekday && (
          <span className="ml-1 text-xs font-normal text-neutral-400">
            ({weekday})
          </span>
        )}
      </button>

      <Arrow
        label={next ? `${next[0]}로` : "다음 일지 없음"}
        disabled={!next}
        onClick={() => next && openNote(next[1])}
      >
        ▶
      </Arrow>

      {!isToday && (
        <button
          className="rounded border border-neutral-300 px-1.5 py-0.5 text-2xs text-neutral-500 hover:border-neutral-500"
          onClick={openToday}
          title="오늘 일지로"
        >
          오늘
        </button>
      )}

      {calendar && (
        <Calendar
          date={date}
          today={today}
          written={new Set(days.map(([d]) => d))}
          onPick={(d) => {
            setCalendar(false);
            if (d === date) return;
            const found = days.find(([x]) => x === d);
            if (found) openNote(found[1]);
            else openDailyDate(d); // 없는 날짜는 그때 만든다
          }}
          onClose={() => setCalendar(false)}
        />
      )}
    </span>
  );
}

function Arrow({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className="rounded px-1 py-0.5 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent"
      disabled={disabled}
      onClick={onClick}
      title={label}
    >
      {children}
    </button>
  );
}

/** 한 달치 달력. 일지를 쓴 날에는 점을 찍는다. */
function Calendar({
  date,
  today,
  written,
  onPick,
  onClose,
}: {
  date: string;
  today: string;
  written: Set<string>;
  onPick: (date: string) => void;
  onClose: () => void;
}) {
  const base = isYmd(date) ? date : today;
  // 열려 있는 날짜가 속한 달부터 보여 준다
  const [ym, setYm] = useState(() => ({
    year: Number(base.slice(0, 4)),
    month: Number(base.slice(5, 7)),
  }));

  const first = new Date(ym.year, ym.month - 1, 1);
  const lastDay = new Date(ym.year, ym.month, 0).getDate();
  const lead = first.getDay();
  const cells: (string | null)[] = [
    ...Array<null>(lead).fill(null),
    ...Array.from({ length: lastDay }, (_, i) => `${ym.year}-${pad(ym.month)}-${pad(i + 1)}`),
  ];

  const shift = (by: number) => {
    const d = new Date(ym.year, ym.month - 1 + by, 1);
    setYm({ year: d.getFullYear(), month: d.getMonth() + 1 });
  };

  return (
    <>
      {/* 바깥을 누르면 닫힌다 */}
      <span className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute left-0 top-full z-50 mt-1 w-60 rounded-lg border border-neutral-200 bg-white p-2 shadow-lg">
        <div className="mb-1 flex items-center justify-between">
          <button
            className="rounded px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100"
            onClick={() => shift(-1)}
          >
            ◀
          </button>
          <span className="text-xs font-semibold">
            {ym.year}년 {ym.month}월
          </span>
          <button
            className="rounded px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100"
            onClick={() => shift(1)}
          >
            ▶
          </button>
        </div>
        <div className="grid grid-cols-7 gap-0.5 text-center">
          {WEEK.map((w) => (
            <span key={w} className="py-0.5 text-3xs text-neutral-400">
              {w}
            </span>
          ))}
          {cells.map((d, i) =>
            d === null ? (
              <span key={`e${i}`} />
            ) : (
              <button
                key={d}
                className={`relative rounded py-1 text-xs hover:bg-neutral-100 ${
                  d === date
                    ? "bg-neutral-800 text-white hover:bg-neutral-700"
                    : d === today
                      ? "font-bold text-neutral-900 ring-1 ring-neutral-300"
                      : "text-neutral-600"
                }`}
                onClick={() => onPick(d)}
                title={written.has(d) ? `${d} (쓴 날)` : `${d} — 새로 만듭니다`}
              >
                {Number(d.slice(8))}
                {written.has(d) && d !== date && (
                  <span className="absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-sky-500" />
                )}
              </button>
            ),
          )}
        </div>
        <p className="mt-1 text-center text-3xs text-neutral-400">
          점은 일지를 쓴 날 · 없는 날을 고르면 새로 만듭니다
        </p>
      </div>
    </>
  );
}
