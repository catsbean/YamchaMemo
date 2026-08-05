import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands, type ReleaseCheck } from "../../bindings";

/** 버전 표시 + GitHub 릴리스로 최신 버전 확인. 자동 설치는 하지 않고
 *  안내만 한다 — 새 버전이 있으면 릴리스 페이지 링크를 보여 준다. */
export default function VersionSection() {
  const [current, setCurrent] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ReleaseCheck | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getVersion().then(setCurrent);
  }, []);

  async function check() {
    setChecking(true);
    setError("");
    setResult(null);
    const r = await commands.checkLatestRelease();
    if (r.status === "ok") setResult(r.data);
    else setError(r.error);
    setChecking(false);
  }

  return (
    <section className="mb-5">
      <h3 className="mb-2 text-sm font-semibold text-neutral-600">버전</h3>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-neutral-600">버전 {current || "…"}</span>
        <button
          className="rounded border border-neutral-300 px-2.5 py-1 text-xs text-neutral-600 hover:border-neutral-500 disabled:opacity-50"
          disabled={checking}
          onClick={check}
        >
          {checking ? "확인 중…" : "새 버전 확인"}
        </button>
      </div>
      {error && <p className="mt-1.5 text-xs text-rose-500">{error}</p>}
      {result &&
        (result.newer ? (
          <p className="mt-1.5 text-xs text-sky-600">
            {result.latest}이 나왔습니다.{" "}
            <button className="underline hover:no-underline" onClick={() => openUrl(result.url)}>
              보러 가기
            </button>
          </p>
        ) : (
          <p className="mt-1.5 text-xs text-neutral-400">최신 버전입니다.</p>
        ))}
    </section>
  );
}
