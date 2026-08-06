import { useMemo, useState } from "react";
import type { IssueKind, NoteIssue } from "../bindings";
import { useVault } from "../stores/vault";
import RawEditModal from "./RawEditModal";

/** 점검 종류별 설명 — 왜 이게 문제인지 한 줄로 */
const KIND_HINT: Record<IssueKind, string> = {
  cloud_conflict_copy:
    "두 기기에서 같은 글을 고치면 클라우드(iCloud 등)가 어느 쪽도 버리지 못하고 사본을 남깁니다. 그대로 두면 한쪽에만 계속 쓰다 나머지 절반을 잃습니다. 두 파일을 열어 비교한 뒤 하나로 합쳐주세요.",
  outside_type_folder:
    "분류 폴더 안에 있어야 목록·검색에 나타납니다. 다른 앱에서 vault 아무 곳에나 만든 파일입니다.",
  parse_error:
    "frontmatter YAML 문법이 깨져 앱이 읽지 못합니다. 목록에서 빠져 있으니 원문을 직접 고쳐주세요.",
  no_frontmatter:
    "맨 위 --- 블록이 없어 날짜·분류를 알 수 없습니다. 다른 앱에서 만든 새 파일에서 흔합니다.",
  missing_date: "날짜가 없거나 형식이 달라 정렬·달력에서 빠집니다.",
  type_mismatch:
    "폴더와 frontmatter의 분류가 다릅니다. 이 앱은 폴더를 기준으로 삼습니다.",
  unknown_status: "상태값이 정의 밖이라 책장·글쓰기 어느 칸에도 들어가지 않습니다.",
};

/** 점검 화면 — 외부 편집기에서 만들어졌거나 고쳐진 파일 중 규격에 맞지 않는 것들 */
export default function AuditDashboard() {
  const { issues, fixIssue, refresh } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [raw, setRaw] = useState<NoteIssue | null>(null);

  // 종류별로 묶어서 보여준다 (같은 문제는 한꺼번에 처리하는 게 자연스럽다)
  const groups = useMemo(() => {
    const map = new Map<IssueKind, NoteIssue[]>();
    for (const i of issues) map.set(i.kind, [...(map.get(i.kind) ?? []), i]);
    return [...map.entries()];
  }, [issues]);

  async function fixOne(i: NoteIssue) {
    setBusy(i.rel_path);
    await fixIssue(i.rel_path, i.kind);
    setBusy(null);
  }

  async function fixGroup(items: NoteIssue[]) {
    setBusy("group");
    for (const i of items) {
      await fixIssue(i.rel_path, i.kind);
    }
    setBusy(null);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-3">
        <h1 className="text-lg font-bold">
          점검{" "}
          <span className="text-sm font-normal text-neutral-400">
            {issues.length}건
          </span>
        </h1>
        <button
          className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:border-neutral-500"
          onClick={refresh}
        >
          다시 검사
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {issues.length === 0 ? (
          <p className="mt-16 text-center text-sm text-neutral-400">
            모든 노트가 규격에 맞습니다. 다른 앱(옵시디언 등)에서 vault를 고쳐도
            여기서 확인할 수 있습니다.
          </p>
        ) : (
          <>
            <p className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-xs text-amber-800">
              아래 파일들은 이 앱의 규격에서 벗어나 있습니다. 일부는 목록·검색에
              아예 나타나지 않습니다. <b>자동으로 고치지 않으니</b> 확인 후
              [고치기]를 눌러주세요. 고치기 전 상태는 편집 기록에 남습니다.
            </p>

            {groups.map(([kind, items]) => (
              <section key={kind} className="mb-6">
                <div className="mb-1 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-neutral-700">
                    {items[0].label}{" "}
                    <span className="font-normal text-neutral-400">
                      {items.length}건
                    </span>
                  </h2>
                  {items[0].fixable && items.length > 1 && (
                    <button
                      className="rounded border border-neutral-300 px-2.5 py-1 text-xs hover:border-neutral-500 disabled:opacity-40"
                      disabled={busy !== null}
                      onClick={() => fixGroup(items)}
                    >
                      {items.length}건 모두 고치기
                    </button>
                  )}
                </div>
                <p className="mb-2 text-xs text-neutral-400">
                  {KIND_HINT[kind]}
                </p>

                <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white">
                  {items.map((i) => (
                    <li
                      key={i.rel_path}
                      className="flex items-center gap-3 px-4 py-2.5"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {i.rel_path}
                        </span>
                        <span className="block truncate text-xs text-neutral-400">
                          {i.detail}
                        </span>
                      </span>
                      {i.fixable ? (
                        <span className="flex shrink-0 items-center gap-2">
                          <span className="hidden text-xs text-neutral-400 lg:inline">
                            {i.suggestion}
                          </span>
                          <button
                            className="rounded bg-neutral-800 px-2.5 py-1 text-xs text-white hover:bg-neutral-600 disabled:opacity-40"
                            disabled={busy !== null}
                            onClick={() => fixOne(i)}
                          >
                            {busy === i.rel_path ? "고치는 중…" : "고치기"}
                          </button>
                        </span>
                      ) : (
                        <button
                          className="shrink-0 rounded border border-rose-300 px-2.5 py-1 text-xs text-rose-600 hover:bg-rose-50"
                          onClick={() => setRaw(i)}
                        >
                          원문 열기
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}
      </div>

      {raw && (
        <RawEditModal
          relPath={raw.rel_path}
          detail={raw.detail}
          onClose={() => setRaw(null)}
        />
      )}
    </div>
  );
}
