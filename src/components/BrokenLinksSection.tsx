import { useEffect, useState } from "react";
import { isCreatable } from "../lib/linkStubs";
import { useVault } from "../stores/vault";

/** 점검 화면의 "가리키는 글이 없는 링크" — 글마다 그 글의 없는 링크들을 칩으로 보인다.
 *
 *  경고가 아니다. 링크를 먼저 써 두고 글은 나중에 채우는 것도 쓰는 방식이라, 위의 규격
 *  문제처럼 [고치기]를 권하지 않는다. 칩을 누르면 그 이름으로 자유노트에 글을 만들고,
 *  글 이름을 누르면 그 글을 연다(링크를 고치거나 지우려면).
 *
 *  자동 수정은 없다 — 점검(audit)의 원칙과 같다. */
export default function BrokenLinksSection() {
  const broken = useVault((s) => s.brokenLinks);
  const openNote = useVault((s) => s.openNote);
  const create = useVault((s) => s.createLinkTargets);
  const [busy, setBusy] = useState<string | null>(null);
  const reload = useVault((s) => s.refreshBrokenLinks);
  // 들어올 때 새로 묻는다 — 방금 쓴 링크가 아직 목록에 없을 수 있다(자동저장은 점검을 돌리지 않는다)
  useEffect(() => {
    void reload();
  }, [reload]);

  if (broken.length === 0) return null;
  const total = broken.reduce((n, b) => n + b.targets.length, 0);

  async function make(target: string) {
    setBusy(target);
    await create([target]);
    setBusy(null);
  }

  return (
    <section className="mb-6">
      <h2 className="mb-1 text-sm font-semibold text-neutral-700">
        가리키는 글이 없는 링크{" "}
        <span className="font-normal text-neutral-400">
          {broken.length}편 · 링크 {total}개
        </span>
      </h2>
      <p className="mb-2 text-xs text-neutral-400">
        아직 없는 글로 이어진 [[링크]]입니다. 글을 나중에 쓰려고 링크부터 걸어 둔 것이면 그대로 두어도
        됩니다. 이름을 누르면 그 이름으로 자유노트에 글을 만들고, 오타였다면 글 이름을 눌러 링크를 고치세요.
        편집기와 기록 카드에서는 이런 링크가 흐린 점선으로 보입니다.
      </p>
      <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white">
        {broken.map((b) => (
          <li key={b.rel_path} className="flex items-start gap-3 px-4 py-2.5">
            <button
              className="w-48 shrink-0 truncate text-left text-sm font-medium hover:underline"
              title={`${b.rel_path} — 열기`}
              onClick={() => openNote(b.rel_path)}
            >
              {b.title}
            </button>
            <span className="flex min-w-0 flex-1 flex-wrap gap-1.5">
              {b.targets.map((t) => {
                const ok = isCreatable(t);
                return (
                  <button
                    key={t}
                    className="rounded border border-dashed border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 hover:border-violet-400 hover:text-violet-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-neutral-300 disabled:hover:text-neutral-500"
                    disabled={!ok || busy !== null}
                    title={
                      ok
                        ? `'${t}' 글을 자유노트에 만듭니다`
                        : "폴더까지 적은 링크나 날짜 모양은 자동으로 만들지 않습니다 — 글을 열어 링크를 고치세요"
                    }
                    onClick={() => make(t)}
                  >
                    {busy === t ? "만드는 중…" : `[[${t}]]`}
                  </button>
                );
              })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
