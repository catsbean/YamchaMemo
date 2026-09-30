import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { commands, type ReleaseCheck } from "../../bindings";
import { useVault } from "../../stores/vault";

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; update: Update; got: number; total: number | null }
  | { kind: "ready" }
  // 자동 설치를 못 하는 새 버전 — 릴리스 페이지로 안내한다 (아래 `checkNow` 설명)
  | { kind: "manual"; release: ReleaseCheck }
  | { kind: "error"; message: string };

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 버전 표시 + 새 버전 받아 설치하기.
 *
 *  GitHub Release의 `latest.json`을 보고(서명을 확인한다) 내려받아 설치한 뒤 다시 켠다.
 *  `latest.json`이 없는 릴리스(자동 업데이트를 넣기 전의 판)나 그걸 못 읽을 때는 예전처럼
 *  릴리스 API로 새 판이 있는지만 보고 페이지 링크를 준다 — 확인 버튼이 오류만 내고 끝나지 않게. */
export default function VersionSection() {
  const [current, setCurrent] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    getVersion().then(setCurrent);
  }, []);

  async function checkNow() {
    setPhase({ kind: "checking" });
    try {
      const update = await check();
      setPhase(update ? { kind: "available", update } : { kind: "latest" });
      return;
    } catch {
      // 아래 릴리스 API로 넘어간다
    }
    const r = await commands.checkLatestRelease();
    if (r.status !== "ok") setPhase({ kind: "error", message: r.error });
    else if (r.data.newer) setPhase({ kind: "manual", release: r.data });
    else setPhase({ kind: "latest" });
  }

  async function install(update: Update) {
    // 설치하면 앱이 닫힌다 — 쓰던 글부터 저장한다
    const vault = useVault.getState();
    if (vault.dirty) await vault.saveCurrent();
    let got = 0;
    let total: number | null = null;
    setPhase({ kind: "downloading", update, got, total });
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? null;
        else if (ev.event === "Progress") got += ev.data.chunkLength;
        setPhase({ kind: "downloading", update, got, total });
      });
      // Windows는 설치 프로그램이 앱을 닫고 새 판을 띄운다. 여기까지 오는 쪽(macOS)은 직접 다시 켠다
      setPhase({ kind: "ready" });
      await relaunch();
    } catch (e) {
      setPhase({ kind: "error", message: `설치하지 못했습니다: ${String(e)}` });
    }
  }

  const btn =
    "rounded border border-neutral-300 px-2.5 py-1 text-xs text-neutral-600 hover:border-neutral-500 disabled:opacity-50";
  const busy = phase.kind === "checking" || phase.kind === "downloading" || phase.kind === "ready";

  return (
    <section className="mb-5">
      <h3 className="mb-2 text-sm font-semibold text-neutral-600">버전</h3>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-neutral-600">버전 {current || "…"}</span>
        <button className={btn} disabled={busy} onClick={checkNow}>
          {phase.kind === "checking" ? "확인 중…" : "새 버전 확인"}
        </button>
      </div>

      {phase.kind === "latest" && (
        <p className="mt-1.5 text-xs text-neutral-400">최신 버전입니다.</p>
      )}
      {phase.kind === "error" && (
        <p className="mt-1.5 text-xs text-rose-500">{phase.message}</p>
      )}
      {phase.kind === "manual" && (
        <p className="mt-1.5 text-xs text-sky-600">
          {phase.release.latest}이 나왔습니다.{" "}
          <button
            className="underline hover:no-underline"
            onClick={() => openUrl(phase.release.url)}
          >
            받으러 가기
          </button>
        </p>
      )}
      {phase.kind === "available" && (
        <div className="mt-1.5 rounded border border-sky-200 bg-sky-50 p-2.5 text-xs">
          <p className="font-medium text-sky-700">{phase.update.version}이 나왔습니다.</p>
          {phase.update.body && (
            <p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-line text-neutral-600">
              {phase.update.body}
            </p>
          )}
          <button
            className="mt-2 rounded bg-neutral-800 px-2.5 py-1 text-white hover:bg-neutral-600"
            onClick={() => install(phase.update)}
          >
            내려받아 설치하고 다시 켜기
          </button>
          <p className="mt-1 text-2xs text-neutral-400">
            쓰던 글은 먼저 저장합니다. 설치하는 동안 앱이 잠시 닫힙니다.
          </p>
        </div>
      )}
      {phase.kind === "downloading" && (
        <div className="mt-1.5" role="status" aria-live="polite">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-neutral-200"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={phase.total ? Math.floor((phase.got * 100) / phase.total) : undefined}
          >
            <div
              className="h-full rounded-full bg-sky-500 transition-[width] duration-200"
              style={{
                width: phase.total ? `${Math.min(100, (phase.got * 100) / phase.total)}%` : "30%",
              }}
            />
          </div>
          <p className="mt-1 text-2xs text-neutral-400 tabular-nums">
            {phase.update.version} 내려받는 중 · {mb(phase.got)}
            {phase.total ? ` / ${mb(phase.total)}` : ""}
          </p>
        </div>
      )}
      {phase.kind === "ready" && (
        <p className="mt-1.5 text-xs text-emerald-600">설치했습니다. 다시 켜는 중…</p>
      )}
    </section>
  );
}
