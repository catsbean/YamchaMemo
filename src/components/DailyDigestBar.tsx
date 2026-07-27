import { useEffect, useState } from "react";
import { commands, type DailyDigest } from "../bindings";
import { useVault } from "../stores/vault";

/** 데일리노트 하단 요약 — 템플릿에 무엇을 쓰든 항상 같은 자리에 뜬다.
 *  오늘 하루를 시작할 때 "지금 뭘 하고 있었지"를 노트를 뒤지지 않고 알 수 있게 한다. */
export default function DailyDigestBar({ date }: { date: string }) {
  const { notes, openNote, setNav } = useVault();
  const [d, setD] = useState<DailyDigest | null>(null);

  // 노트 목록이 갱신될 때마다(저장·기록 추가) 다시 계산
  useEffect(() => {
    if (!date) return;
    commands.dailyDigest(date).then((r) => setD(r.status === "ok" ? r.data : null));
  }, [date, notes]);

  if (!d) return null;

  const readingLabel =
    d.reading_count === 0
      ? "읽는 중 없음"
      : d.reading_count === 1
        ? `읽는 중 «${d.reading_titles[0]}»`
        : `읽는 중 «${d.reading_titles[0]}» 외 ${d.reading_count - 1}권`;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-neutral-100 bg-neutral-50 px-4 py-1.5 text-[11px] text-neutral-500">
      <span title="내용이 있는 미완 할 일만 셉니다">
        ☑{" "}
        <b className={d.open_todos_today > 0 ? "text-amber-600" : ""}>
          오늘 {d.open_todos_today}
        </b>
        {d.open_todos_total !== d.open_todos_today && (
          <span className="text-neutral-400"> · 전체 {d.open_todos_total}</span>
        )}
      </span>

      <span className="text-neutral-300">·</span>

      <button
        className="hover:text-neutral-800 hover:underline"
        onClick={() =>
          d.reading_count === 1 && d.reading_rels[0]
            ? openNote(d.reading_rels[0])
            : setNav("book")
        }
        title={d.reading_titles.join(", ") || "책장 열기"}
      >
        📖 {readingLabel}
      </button>

      <span className="text-neutral-300">·</span>

      <button
        className="hover:text-neutral-800 hover:underline"
        onClick={() => setNav("book")}
        title="완독한 책"
      >
        ✅ 올해 {d.finished_this_year}권
        <span className="text-neutral-400"> · 누적 {d.finished_total}권</span>
      </button>

      <span className="text-neutral-300">·</span>

      <button
        className="hover:text-neutral-800 hover:underline"
        onClick={() => setNav("reading")}
        title="독서기록 모아보기"
      >
        ✍️{" "}
        {d.today_entry_count === 0 ? (
          <span className="text-neutral-400">오늘 남긴 기록 없음</span>
        ) : (
          <>
            오늘 기록 <b>{d.today_entry_count}</b>
            <span className="text-neutral-400">
              {" "}
              (
              {d.today_entries
                .slice(0, 3)
                .map((e) => `${e.book_title} ${e.count}`)
                .join(" · ")}
              {d.today_entries.length > 3 ? " …" : ""})
            </span>
          </>
        )}
      </button>
    </div>
  );
}
