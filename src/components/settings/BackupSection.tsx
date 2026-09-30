import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { commands, type BackupReport } from "../../bindings";
import { ymd } from "../../lib/date";
import { useVault } from "../../stores/vault";

type Progress = { done: number; total: number };
type Job = "backup" | "restore";

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function summary(r: BackupReport): string {
  return `노트 ${r.notes.toLocaleString()}편 · 파일 ${r.files.toLocaleString()}개 · ${sizeLabel(r.bytes)}`;
}

/** 백업과 복원 — vault를 zip 하나로 묶고, **빈 폴더로만** 되푼다.
 *
 *  복원은 지금 vault를 덮지 않는다. 다 풀고 나서 그 폴더를 열지는 사용자가 고른다.
 *  도는 동안에는 설정 창을 닫지 못하게 한다(`onBusy`) — 닫으면 진행도 결과도 볼 곳이 없다. */
export default function BackupSection({ onBusy }: { onBusy: (busy: boolean) => void }) {
  const { vaultPath, openVaultAt } = useVault();
  const [job, setJob] = useState<Job | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  // 복원을 마친 폴더 — [이 폴더 열기]를 보여 준다
  const [restoredAt, setRestoredAt] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen<Progress>("backup-progress", (e) => setProgress(e.payload)).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  async function run(kind: Job, work: () => Promise<void>) {
    setJob(kind);
    setProgress(null);
    setMessage("");
    setError("");
    setRestoredAt(null);
    onBusy(true);
    try {
      await work();
    } finally {
      setJob(null);
      onBusy(false);
    }
  }

  async function backup() {
    const dest = await saveDialog({
      title: "백업 파일 저장 — vault 밖의 폴더를 고르세요",
      defaultPath: `YamchaMemo-백업-${ymd(new Date())}.zip`,
      filters: [{ name: "zip", extensions: ["zip"] }],
    });
    if (!dest) return;
    await run("backup", async () => {
      const r = await commands.backupVault(dest);
      if (r.status === "ok") setMessage(`백업을 만들었습니다 — ${summary(r.data)}`);
      else setError(r.error);
    });
  }

  async function restore() {
    const zip = await openDialog({
      title: "복원할 백업 파일 고르기",
      filters: [{ name: "zip", extensions: ["zip"] }],
    });
    if (typeof zip !== "string") return;
    const dest = await openDialog({
      directory: true,
      title: "복원할 빈 폴더 고르기 — 새 폴더를 만들어 고르세요",
    });
    if (typeof dest !== "string") return;
    await run("restore", async () => {
      const r = await commands.restoreBackup(zip, dest);
      if (r.status === "ok") {
        setMessage(`복원했습니다 — ${summary(r.data)}`);
        setRestoredAt(dest);
      } else setError(r.error);
    });
  }

  const pct =
    progress && progress.total > 0
      ? Math.floor((progress.done * 100) / progress.total)
      : 0;
  const btn =
    "rounded border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-500 disabled:opacity-50";

  return (
    <section className="mb-5">
      <h3 className="mb-1 text-sm font-semibold text-neutral-600">백업과 복원</h3>
      <p className="mb-2 text-xs text-neutral-400">
        노트·첨부·분류 설정·템플릿을 zip 파일 하나로 묶습니다. 복원은 지금 vault를
        건드리지 않고 <b className="font-medium text-neutral-500">빈 폴더</b>에만
        풉니다.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button className={btn} disabled={job != null || !vaultPath} onClick={backup}>
          {job === "backup" ? "묶는 중…" : "백업 만들기"}
        </button>
        <button className={btn} disabled={job != null} onClick={restore}>
          {job === "restore" ? "푸는 중…" : "백업에서 복원"}
        </button>
      </div>

      {job && (
        <div className="mt-2" role="status" aria-live="polite">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-neutral-200"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <div
              className="h-full rounded-full bg-sky-500 transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1 text-2xs text-neutral-400 tabular-nums">
            {progress && progress.total > 0
              ? `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}개 · ${pct}%`
              : "준비 중"}
          </p>
        </div>
      )}

      {message && <p className="mt-1.5 text-xs text-emerald-600">{message}</p>}
      {error && <p className="mt-1.5 text-xs text-rose-500">{error}</p>}
      {restoredAt && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
          <span className="break-all text-neutral-500">{restoredAt}</span>
          <button
            className="rounded bg-neutral-800 px-2.5 py-1 text-white hover:bg-neutral-600"
            onClick={() => openVaultAt(restoredAt)}
            title="지금 vault를 닫고 복원한 폴더를 엽니다. 지금 vault는 그대로 남습니다."
          >
            이 폴더 열기
          </button>
        </div>
      )}
    </section>
  );
}
