import { useEffect, useState } from "react";
import { load } from "@tauri-apps/plugin-store";
import { listen } from "@tauri-apps/api/event";
import {
  commands,
  type EnrichPreview,
  type EnrichProposal,
  type EnrichReport,
} from "../bindings";
import { useVault } from "../stores/vault";
import Modal from "./Modal";

type Progress = { done: number; total: number; title: string };

type Mode = "all" | "review";

/** 부실한 책 정보를 카카오(메타)+교보(소개)로 자동 채우기 */
export default function EnrichDialog({ onClose }: { onClose: () => void }) {
  const refresh = useVault((s) => s.refresh);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [limit, setLimit] = useState(100);
  const [mode, setMode] = useState<Mode>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [canceling, setCanceling] = useState(false);

  // 모두 자동 모드
  const [report, setReport] = useState<EnrichReport | null>(null);

  // 책마다 확인 모드
  const [preview, setPreview] = useState<EnrichPreview | null>(null);
  const [reviewIdx, setReviewIdx] = useState(0);
  const [applied, setApplied] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [reviewDone, setReviewDone] = useState(false);

  useEffect(() => {
    load("settings.json", { autoSave: true, defaults: {} }).then(async (s) => {
      setApiKey((await s.get<string>("kakaoApiKey")) ?? "");
    });
  }, []);

  // 진행률 이벤트 수신 (일괄 자동채우기 루프에서 책마다 emit)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen<Progress>("enrich-progress", (e) => setProgress(e.payload)).then(
      (fn) => {
        if (disposed) fn();
        else unlisten = fn;
      },
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  async function run() {
    if (busy) return;
    setBusy(true);
    setCanceling(false);
    setProgress(null);
    setError("");
    setReport(null);
    setPreview(null);
    setReviewDone(false);
    setReviewIdx(0);
    setApplied(0);
    setSkipped(0);

    if (mode === "all") {
      const r = await commands.enrichBooks(apiKey ?? "", limit);
      if (r.status === "ok") {
        setReport(r.data);
        await refresh();
      } else {
        setError(r.error);
      }
    } else {
      const r = await commands.enrichPreview(apiKey ?? "", limit);
      if (r.status === "ok") {
        setPreview(r.data);
        if (r.data.proposals.length === 0) setReviewDone(true);
      } else {
        setError(r.error);
      }
    }
    setProgress(null);
    setBusy(false);
  }

  async function cancel() {
    setCanceling(true);
    await commands.cancelEnrich();
  }

  function nextReview() {
    setReviewIdx((i) => {
      const next = i + 1;
      if (preview && next >= preview.proposals.length) {
        setReviewDone(true);
        refresh();
        return i;
      }
      return next;
    });
  }

  async function acceptCurrent(p: EnrichProposal) {
    if (busy) return;
    setBusy(true);
    const r = await commands.enrichApplyOne(p);
    if (r.status === "ok") setApplied((n) => n + 1);
    else setError(r.error);
    setBusy(false);
    nextReview();
  }

  function skipCurrent() {
    setSkipped((n) => n + 1);
    nextReview();
  }

  const cur = preview?.proposals[reviewIdx];

  return (
    <Modal onClose={onClose} locked={busy} panelClassName="w-[32rem] rounded-lg p-5 shadow-xl">
        <h2 className="mb-1 text-base font-bold">책 정보 자동 채우기</h2>
        <p className="mb-4 text-xs text-neutral-500">
          저자·출판사·ISBN·표지는 카카오 책 검색으로, <b>책 소개</b>는 ISBN으로
          교보문고에서 가져옵니다. 이미 입력된 값은 건드리지 않습니다.
        </p>

        {/* 진행 중: 진행률 바 + 취소 */}
        {busy && (
          <div className="mb-4 rounded-lg border border-neutral-200 p-3">
            <div className="mb-2 flex items-center justify-between text-xs text-neutral-500">
              <span>
                {progress
                  ? `${progress.done} / ${progress.total} · ${progress.title}`
                  : "준비 중…"}
              </span>
              <button
                className="rounded px-2 py-0.5 text-neutral-500 hover:bg-neutral-100 disabled:opacity-50"
                disabled={canceling}
                onClick={cancel}
              >
                {canceling ? "중단하는 중…" : "취소"}
              </button>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded bg-neutral-100">
              <div
                className="h-full rounded bg-neutral-800 transition-all"
                style={{
                  width: progress
                    ? `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%`
                    : "10%",
                }}
              />
            </div>
          </div>
        )}

        {/* 시작 화면 */}
        {!report && !preview && (
          <>
            <div className="mb-3 flex flex-col gap-2">
              {(
                [
                  ["all", "묻지 않고 모두 채우기", "대상 책을 한 번에 자동으로 채웁니다."],
                  ["review", "책마다 확인", "책을 한 권씩 보여주고 채울지 직접 고릅니다."],
                ] as const
              ).map(([v, label, desc]) => (
                <label
                  key={v}
                  className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 ${
                    mode === v
                      ? "border-neutral-800 bg-neutral-50"
                      : "border-neutral-200 hover:border-neutral-400"
                  }`}
                >
                  <input
                    type="radio"
                    className="mt-1"
                    checked={mode === v}
                    onChange={() => setMode(v)}
                  />
                  <span>
                    <span className="block text-sm font-medium">{label}</span>
                    <span className="block text-xs text-neutral-500">{desc}</span>
                  </span>
                </label>
              ))}
            </div>
            <label className="mb-4 flex items-center gap-2 text-sm">
              <span className="text-neutral-500">한 번에 최대</span>
              <select
                className="rounded border border-neutral-300 px-2 py-1"
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                disabled={busy}
              >
                <option value={50}>50권</option>
                <option value={100}>100권</option>
                <option value={200}>200권</option>
              </select>
              <span className="text-neutral-400">(API 한도에 닿으면 자동 중단)</span>
            </label>
            {error && <p className="mb-2 text-sm text-rose-500">{error}</p>}
            <div className="flex justify-end gap-2">
              <button
                className="rounded px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100"
                onClick={onClose}
              >
                취소
              </button>
              <button
                className="rounded bg-neutral-800 px-4 py-1.5 text-sm text-white hover:bg-neutral-600 disabled:opacity-50"
                disabled={busy}
                onClick={run}
              >
                {busy ? "진행 중…" : "시작"}
              </button>
            </div>
          </>
        )}

        {/* 모두 자동: 결과 리포트 */}
        {report && (
          <div className="text-sm">
            <div className="mb-3 rounded-lg border border-neutral-200 p-3">
              <p className="mb-2 font-semibold">
                {report.enriched}권 채움{" "}
                <span className="font-normal text-neutral-400">
                  (대상 {report.candidates}권 중 {report.processed}권 처리)
                </span>
              </p>
              <ul className="space-y-0.5 text-xs text-neutral-600">
                <li>· 분야 채움: {report.filled_genre}권</li>
                <li>· 소개 채움: {report.filled_intro}권</li>
                <li>· 저자·출판사·표지 등: {report.filled_meta}권</li>
              </ul>
              {report.stopped_rate_limit && (
                <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">
                  ⚠️ API 요청 한도에 도달해 중단했습니다. 남은 {report.remaining}권은
                  잠시 후(또는 내일) 다시 실행해 주세요.
                </p>
              )}
              {!report.stopped_rate_limit && report.remaining > 0 && (
                <p className="mt-2 text-xs text-neutral-500">
                  제한(최대 {limit}권)으로 {report.remaining}권이 남았습니다. 다시
                  실행하면 이어서 채웁니다.
                </p>
              )}
              {report.errors.length > 0 && (
                <details className="mt-2 text-xs text-neutral-400">
                  <summary>매칭 실패 {report.errors.length}건</summary>
                  <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto">
                    {report.errors.slice(0, 30).map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            <div className="flex justify-end gap-2">
              {report.remaining > 0 && !report.stopped_rate_limit && (
                <button
                  className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:border-neutral-500 disabled:opacity-50"
                  disabled={busy}
                  onClick={run}
                >
                  {busy ? "채우는 중…" : "이어서 실행"}
                </button>
              )}
              <button
                className="rounded bg-neutral-800 px-4 py-1.5 text-sm text-white hover:bg-neutral-600"
                onClick={onClose}
              >
                닫기
              </button>
            </div>
          </div>
        )}

        {/* 책마다 확인: 스텝 UI */}
        {preview && !reviewDone && cur && (
          <div className="text-sm">
            <p className="mb-2 text-xs text-neutral-400">
              {reviewIdx + 1} / {preview.proposals.length} · 채움 {applied} · 건너뜀{" "}
              {skipped}
            </p>
            <div className="mb-3 rounded-lg border border-neutral-200 p-3">
              <p className="mb-2 font-semibold">{cur.title}</p>
              <ul className="space-y-1 text-xs text-neutral-700">
                {cur.new_author && (
                  <li>
                    <b>저자</b>{" "}
                    {cur.cur_author && (
                      <span className="text-neutral-400 line-through">
                        {cur.cur_author}{" "}
                      </span>
                    )}
                    → {cur.new_author}
                  </li>
                )}
                {cur.new_publisher && (
                  <li>
                    <b>출판사</b> → {cur.new_publisher}
                  </li>
                )}
                {cur.new_isbn && (
                  <li>
                    <b>ISBN</b> → {cur.new_isbn}
                  </li>
                )}
                {cur.new_genre && (
                  <li>
                    <b>분야</b> → {cur.new_genre}
                  </li>
                )}
                {cur.new_cover_url && (
                  <li className="flex items-center gap-2">
                    <b>표지</b>
                    <img
                      src={cur.new_cover_url}
                      alt=""
                      className="h-14 w-10 rounded object-cover shadow"
                    />
                  </li>
                )}
                {cur.new_intro && (
                  <li>
                    <b>소개</b>
                    <div className="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap text-neutral-600">
                      {cur.new_intro}
                    </div>
                  </li>
                )}
              </ul>
            </div>
            {error && <p className="mb-2 text-xs text-rose-500">{error}</p>}
            <div className="flex justify-between gap-2">
              <button
                className="rounded px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100"
                onClick={onClose}
              >
                중단
              </button>
              <div className="flex gap-2">
                <button
                  className="rounded border border-neutral-300 px-4 py-1.5 text-sm hover:border-neutral-500 disabled:opacity-50"
                  disabled={busy}
                  onClick={skipCurrent}
                >
                  건너뛰기
                </button>
                <button
                  className="rounded bg-neutral-800 px-4 py-1.5 text-sm text-white hover:bg-neutral-600 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => acceptCurrent(cur)}
                >
                  {busy ? "채우는 중…" : "채우기"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 책마다 확인: 완료 */}
        {preview && reviewDone && (
          <div className="text-sm">
            <div className="mb-3 rounded-lg border border-neutral-200 p-3">
              {preview.proposals.length === 0 ? (
                <p className="font-semibold">채울 책이 없습니다.</p>
              ) : (
                <p className="font-semibold">
                  {applied}권 채움{" "}
                  <span className="font-normal text-neutral-400">
                    (건너뜀 {skipped}권)
                  </span>
                </p>
              )}
              {preview.stopped_rate_limit && (
                <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">
                  ⚠️ API 한도로 일부만 준비했습니다. 잠시 후 다시 실행해 주세요.
                </p>
              )}
            </div>
            <div className="flex justify-end">
              <button
                className="rounded bg-neutral-800 px-4 py-1.5 text-sm text-white hover:bg-neutral-600"
                onClick={onClose}
              >
                닫기
              </button>
            </div>
          </div>
        )}
    </Modal>
  );
}
