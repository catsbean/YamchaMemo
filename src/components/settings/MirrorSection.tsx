import { useState } from "react";
import { useVault } from "../../stores/vault";
import { Section } from "./ui";

/** 미러 폴더 — 저장할 때마다 vault를 다른 폴더로 복제 */
export default function MirrorSection() {
  const { mirrors, mirrorReports, addMirror, removeMirror, syncMirrors, resolveMirrorConflict } = useVault();
  const [syncing, setSyncing] = useState(false);

  return (
    <Section
      title="미러(백업) 폴더"
      desc={
        <>
          저장할 때마다 vault를 이 폴더들로 자동 복제합니다. OneDrive·Google
          Drive 등 클라우드 동기화 폴더를 지정하면 자동 백업이 됩니다.
        </>
      }
    >
      <ul className="mb-2 flex flex-col gap-1">
        {mirrors.map((m) => {
          const report = mirrorReports.find((r) => r.target === m);
          return (
            <li
              key={m}
              className="rounded border border-neutral-200 px-3 py-1.5 text-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate" title={m}>
                  {m}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {report && (
                    <span className="text-neutral-400">
                      복사 {report.copied} · 최신 {report.skipped}
                      {report.errors.length > 0 && (
                        <span className="text-rose-500">
                          {" "}
                          · 오류 {report.errors.length}
                        </span>
                      )}
                    </span>
                  )}
                  <button
                    className="text-rose-400 hover:text-rose-600"
                    onClick={() => removeMirror(m)}
                  >
                    제거
                  </button>
                </span>
              </div>
              {report && report.errors.length > 0 && (
                <p className="mt-1 break-all text-rose-500" title={report.errors.join("\n")}>
                  {report.errors[0]}
                  {report.errors.length > 1 && ` 외 ${report.errors.length - 1}건`}
                </p>
              )}
              {report && report.conflicts.length > 0 && (
                <div className="mt-1.5 rounded bg-amber-50 p-2">
                  <p className="mb-1 font-semibold text-amber-700">
                    ⚠️ 충돌 {report.conflicts.length}건 — 미러 쪽 파일이 더
                    새롭습니다
                  </p>
                  <ul className="flex flex-col gap-1">
                    {report.conflicts.map((rel) => (
                      <li
                        key={rel}
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="truncate text-amber-800">{rel}</span>
                        <span className="flex shrink-0 gap-1">
                          <button
                            className="rounded bg-white px-1.5 py-0.5 text-3xs text-neutral-600 hover:bg-neutral-100"
                            onClick={() =>
                              resolveMirrorConflict(m, rel, false)
                            }
                            title="vault 내용으로 미러를 덮어씁니다"
                          >
                            vault 우선
                          </button>
                          <button
                            className="rounded bg-white px-1.5 py-0.5 text-3xs text-neutral-600 hover:bg-neutral-100"
                            onClick={() =>
                              resolveMirrorConflict(m, rel, true)
                            }
                            title="미러 내용을 vault로 가져옵니다"
                          >
                            미러에서 가져오기
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex gap-2">
        <button
          className="rounded border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-500"
          onClick={addMirror}
        >
          + 미러 폴더 추가
        </button>
        {mirrors.length > 0 && (
          <button
            className="rounded border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-500 disabled:opacity-50"
            disabled={syncing}
            onClick={async () => {
              setSyncing(true);
              await syncMirrors();
              setSyncing(false);
            }}
          >
            {syncing ? "동기화 중…" : "지금 동기화"}
          </button>
        )}
      </div>
    </Section>
  );
}
