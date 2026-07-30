import { useEffect, useMemo, useState } from "react";
import { commands, type NoteBlock, type NoteTodo } from "../bindings";
import { kindByLabel, styleOf } from "../lib/callouts";
import { bodyToHtml, wrapDocument } from "../lib/exportHtml";
import { printHtml, saveTextAs } from "../lib/exportFile";
import { useVault } from "../stores/vault";
import NoteText from "./NoteText";

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const WEEK = ["일", "월", "화", "수", "목", "금", "토"];

/** `Daily/2026/07/2026-07-30.md` → `2026-07-30` */
const dateOf = (rel: string) => rel.split("/").pop()?.replace(/\.md$/, "") ?? "";

interface Day {
  date: string;
  rel: string;
  blocks: NoteBlock[];
  todos: NoteTodo[];
}

/** 주간·월간 회고 — 여러 날의 기록과 할 일을 한 화면에 모아 본다.
 *
 *  일지는 하루 단위로 쓰지만 돌아볼 때는 주·월 단위로 본다. 날짜를 하나씩
 *  열어 가며 훑는 대신 한 번에 펼쳐 놓는다. */
export default function ReviewDashboard() {
  const notes = useVault((s) => s.notes);
  const openNote = useVault((s) => s.openNote);
  const callouts = useVault((s) => s.callouts);
  const [span, setSpan] = useState<"week" | "month">("week");
  /** 기준점 — 이 날이 속한 주/달을 본다 */
  const [anchor, setAnchor] = useState(() => ymd(new Date()));
  const [days, setDays] = useState<Day[] | null>(null);
  const [kindOff, setKindOff] = useState<Set<string>>(new Set());

  const { from, to, label } = useMemo(() => range(span, anchor), [span, anchor]);

  /** 기간 안의 일지 경로 (최신 날짜가 위로) */
  const rels = useMemo(
    () =>
      notes
        .filter((n) => n.note_type === "daily")
        .map((n) => ({ date: dateOf(n.rel_path), rel: n.rel_path }))
        .filter((d) => d.date >= from && d.date <= to)
        .sort((a, b) => b.date.localeCompare(a.date)),
    [notes, from, to],
  );

  useEffect(() => {
    let alive = true;
    setDays(null);
    (async () => {
      const out: Day[] = [];
      for (const d of rels) {
        const [b, t] = await Promise.all([
          commands.noteBlocks(d.rel),
          commands.noteTodos(d.rel),
        ]);
        out.push({
          date: d.date,
          rel: d.rel,
          blocks: b.status === "ok" ? b.data : [],
          todos: t.status === "ok" ? t.data : [],
        });
      }
      if (alive) setDays(out);
    })();
    return () => {
      alive = false;
    };
  }, [rels]);

  const shift = (by: number) => setAnchor(step(span, anchor, by));

  // 기간 전체 집계
  const stat = useMemo(() => {
    const all = days ?? [];
    const todos = all.flatMap((d) => d.todos);
    const entries = all.flatMap((d) =>
      d.blocks.filter((b) => b.kind === "callout"),
    );
    const byKind = new Map<string, number>();
    for (const e of entries)
      byKind.set(e.kind_label, (byKind.get(e.kind_label) ?? 0) + 1);
    return {
      일수: all.length,
      기록: entries.length,
      끝낸할일: todos.filter((t) => t.done).length,
      남은할일: todos.filter((t) => !t.done).length,
      종류별: [...byKind.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [days]);

  const visible = (kind: string) => !kindOff.has(kind);

  /** 지금 보고 있는 회고를 문서 한 장으로 */
  function buildHtml(): string {
    const md = (days ?? [])
      .map((d) => {
        const head = `## ${d.date} (${weekdayOf(d.date)})`;
        const todo = d.todos.length
          ? d.todos
              .map((t) => `- [${t.done ? "x" : " "}] ${t.text}`)
              .join("\n")
          : "";
        const rec = d.blocks
          .filter((b) => b.kind === "callout" && visible(b.kind_label))
          .map((b) => `> [!${b.kind_label}] ${b.date}\n> ${b.text.split("\n").join("\n> ")}`)
          .join("\n\n");
        return [head, todo, rec].filter(Boolean).join("\n\n");
      })
      .join("\n\n");
    const meta = `${label} · 기록 ${stat.기록}건 · 끝낸 할 일 ${stat.끝낸할일}건`;
    return wrapDocument(`회고 ${label}`, bodyToHtml(md), meta);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-6 py-3">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold">회고</h1>
          <div className="flex gap-1 text-xs">
            {(
              [
                ["week", "주간"],
                ["month", "월간"],
              ] as const
            ).map(([v, t]) => (
              <button
                key={v}
                className={`rounded px-2.5 py-1 ${
                  span === v
                    ? "bg-neutral-800 text-white"
                    : "text-neutral-500 hover:bg-neutral-100"
                }`}
                onClick={() => setSpan(v)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
            onClick={() => shift(-1)}
            title="이전"
          >
            ◀
          </button>
          <span className="min-w-40 text-center text-sm font-medium">{label}</span>
          <button
            className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
            onClick={() => shift(1)}
            title="다음"
          >
            ▶
          </button>
          <button
            className="ml-1 rounded border border-neutral-300 px-2 py-1 text-2xs text-neutral-500 hover:border-neutral-500"
            onClick={() => setAnchor(ymd(new Date()))}
          >
            이번 {span === "week" ? "주" : "달"}
          </button>
          <button
            className="ml-2 rounded border border-neutral-300 px-2.5 py-1 text-xs text-neutral-600 hover:border-neutral-500 disabled:opacity-40"
            disabled={!days || days.length === 0}
            onClick={() => printHtml(buildHtml())}
            title="인쇄 창에서 PDF로 저장할 수 있습니다"
          >
            🖨️ 인쇄
          </button>
          <button
            className="rounded border border-neutral-300 px-2.5 py-1 text-xs text-neutral-600 hover:border-neutral-500 disabled:opacity-40"
            disabled={!days || days.length === 0}
            onClick={() => saveTextAs(`회고 ${label}`, "html", "HTML 문서", buildHtml())}
          >
            ⬇ HTML
          </button>
        </div>
      </header>

      {/* 기간 집계 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-neutral-100 px-6 py-2 text-xs text-neutral-500">
        <span>
          쓴 날 <b className="text-neutral-800">{stat.일수}</b>일
        </span>
        <span>
          기록 <b className="text-neutral-800">{stat.기록}</b>건
        </span>
        <span>
          끝낸 할 일 <b className="text-emerald-600">{stat.끝낸할일}</b>
        </span>
        <span>
          남은 할 일 <b className="text-neutral-800">{stat.남은할일}</b>
        </span>
        {stat.종류별.length > 0 && (
          <span className="ml-auto flex flex-wrap gap-1">
            {stat.종류별.map(([kind, n]) => {
              const k = kindByLabel(
                kind,
                callouts.map((c) => ({
                  label: c.label,
                  icon: c.icon ?? "",
                  color: c.color as never,
                })),
              );
              const on = visible(kind);
              return (
                <button
                  key={kind}
                  className={`rounded-full border border-current/10 px-2 py-0.5 ${
                    on ? styleOf(k.color).active : "bg-neutral-100 text-neutral-400"
                  }`}
                  onClick={() =>
                    setKindOff((s) => {
                      const next = new Set(s);
                      if (next.has(kind)) next.delete(kind);
                      else next.add(kind);
                      return next;
                    })
                  }
                  title={on ? "이 종류 숨기기" : "다시 보기"}
                >
                  {k.icon} {kind} {n}
                </button>
              );
            })}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {days === null && (
          <p className="mt-16 text-center text-sm text-neutral-400">불러오는 중…</p>
        )}
        {days?.length === 0 && (
          <p className="mt-16 text-center text-sm text-neutral-400">
            이 {span === "week" ? "주" : "달"}에는 쓴 일지가 없습니다.
          </p>
        )}
        {days?.map((d) => {
          const recs = d.blocks.filter(
            (b) => b.kind === "callout" && visible(b.kind_label),
          );
          const done = d.todos.filter((t) => t.done);
          const open = d.todos.filter((t) => !t.done);
          if (recs.length === 0 && d.todos.length === 0) return null;
          return (
            <section key={d.rel} className="mb-6">
              <button
                className="mb-2 flex items-baseline gap-2 rounded px-1 hover:bg-neutral-100"
                onClick={() => openNote(d.rel)}
                title="이 날 일지 열기"
              >
                <h2 className="text-sm font-bold">{d.date}</h2>
                <span className="text-2xs text-neutral-400">
                  ({weekdayOf(d.date)})
                </span>
                {done.length > 0 && (
                  <span className="text-2xs text-emerald-600">
                    ✅ {done.length}
                  </span>
                )}
              </button>

              {open.length + done.length > 0 && (
                <ul className="mb-2 flex flex-col gap-0.5">
                  {[...open, ...done].map((t) => (
                    <li key={t.index} className="flex gap-1.5 text-sm">
                      <span
                        className={
                          t.done ? "text-emerald-600" : "text-neutral-400"
                        }
                      >
                        {t.done ? "☑" : "☐"}
                      </span>
                      <span
                        className={
                          t.done ? "text-neutral-400 line-through" : "text-neutral-800"
                        }
                      >
                        {t.text}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex flex-col gap-1.5">
                {recs.map((b, i) => {
                  const k = kindByLabel(
                    b.kind_label,
                    callouts.map((c) => ({
                      label: c.label,
                      icon: c.icon ?? "",
                      color: c.color as never,
                    })),
                  );
                  return (
                    <div
                      key={i}
                      className={`rounded-md border px-3 py-2 ${styleOf(k.color).card}`}
                    >
                      <div className="mb-0.5 text-2xs font-semibold opacity-70">
                        {k.icon} {b.kind_label}
                        {b.date && <span className="ml-1.5 font-normal">{b.date}</span>}
                      </div>
                      <NoteText
                        text={b.text}
                        className="whitespace-pre-wrap text-sm"
                      />
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function weekdayOf(date: string): string {
  return WEEK[new Date(`${date}T00:00:00`).getDay()];
}

/** 기준 날짜가 속한 주(월~일) 또는 달의 범위 */
function range(span: "week" | "month", anchor: string) {
  const d = new Date(`${anchor}T00:00:00`);
  if (span === "month") {
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return {
      from: ymd(first),
      to: ymd(last),
      label: `${first.getFullYear()}년 ${first.getMonth() + 1}월`,
    };
  }
  // 월요일 시작
  const wd = (d.getDay() + 6) % 7;
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - wd);
  const sun = new Date(d.getFullYear(), d.getMonth(), d.getDate() - wd + 6);
  return {
    from: ymd(mon),
    to: ymd(sun),
    label: `${ymd(mon)} ~ ${ymd(sun)}`,
  };
}

function step(span: "week" | "month", anchor: string, by: number): string {
  const d = new Date(`${anchor}T00:00:00`);
  if (span === "month") return ymd(new Date(d.getFullYear(), d.getMonth() + by, 1));
  return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + by * 7));
}
