import { useEffect, useState } from "react";
import { load } from "@tauri-apps/plugin-store";
import { commands } from "../bindings";
import { useVault, type LayoutMode } from "../stores/vault";
import { openTrashWindow } from "../lib/trashWindow";
import Modal from "./Modal";

const LAYOUTS: { value: LayoutMode; label: string; desc: string }[] = [
  {
    value: "three",
    label: "3단 보기",
    desc: "메뉴 | 목록 | 편집기를 나란히 표시",
  },
  {
    value: "vertical",
    label: "상하 분할",
    desc: "목록을 위에, 편집기를 아래에 표시",
  },
  {
    value: "replace",
    label: "전체 전환",
    desc: "노트를 열면 목록 대신 편집기만 표시 (← 버튼으로 복귀)",
  },
];

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const {
    layout,
    setLayout,
    vaultPath,
    chooseVault,
    schemas,
    reindexAll,
    mirrors,
    mirrorReports,
    addMirror,
    removeMirror,
    syncMirrors,
    resolveMirrorConflict,
    deleteConfirm,
    setDeleteConfirm,
    bookPickerView,
    setBookPickerView,
  } = useVault();
  const [syncing, setSyncing] = useState(false);
  const removeCustom = useVault((s) => s.refreshSchemas);
  const [reindexing, setReindexing] = useState(false);
  const [reindexDone, setReindexDone] = useState(false);
  const [reindexCount, setReindexCount] = useState<number | null>(null);
  const [kakaoKey, setKakaoKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);

  useEffect(() => {
    load("settings.json", { autoSave: true, defaults: {} }).then(async (s) => {
      setKakaoKey((await s.get<string>("kakaoApiKey")) ?? "");
    });
  }, []);

  async function saveKakaoKey() {
    const s = await load("settings.json", { autoSave: true, defaults: {} });
    await s.set("kakaoApiKey", kakaoKey.trim());
    setKeySaved(true);
    setTimeout(() => setKeySaved(false), 2000);
  }

  const customs = schemas.filter((s) => !s.builtin);

  async function runReindex() {
    setReindexing(true);
    setReindexDone(false);
    try {
      const n = await reindexAll();
      setReindexCount(typeof n === "number" ? n : null);
      setReindexDone(true);
    } finally {
      setReindexing(false);
    }
  }

  return (
    <Modal
      onClose={onClose}
      locked={reindexing}
      panelClassName="max-h-[85vh] w-[30rem] overflow-y-auto rounded-lg p-5 shadow-xl"
    >
        <h2 className="mb-4 text-base font-bold">설정</h2>

        <section className="mb-5">
          <h3 className="mb-2 text-sm font-semibold text-neutral-600">
            편집 시 목록 표시
          </h3>
          <div className="flex flex-col gap-1.5">
            {LAYOUTS.map((l) => (
              <label
                key={l.value}
                className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 ${
                  layout === l.value
                    ? "border-neutral-800 bg-neutral-50"
                    : "border-neutral-200 hover:border-neutral-400"
                }`}
              >
                <input
                  type="radio"
                  className="mt-1"
                  checked={layout === l.value}
                  onChange={() => setLayout(l.value)}
                />
                <span>
                  <span className="block text-sm font-medium">{l.label}</span>
                  <span className="block text-xs text-neutral-500">{l.desc}</span>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section className="mb-5">
          <h3 className="mb-2 text-sm font-semibold text-neutral-600">Vault</h3>
          <p className="mb-1 break-all text-xs text-neutral-500">{vaultPath}</p>
          <div className="flex gap-2">
            <button
              className="rounded border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-500"
              onClick={chooseVault}
            >
              vault 변경
            </button>
            <button
              className="rounded border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-500 disabled:opacity-50"
              disabled={reindexing}
              onClick={runReindex}
            >
              {reindexing ? "재색인 중…" : "전체 재색인"}
            </button>
            {reindexDone && (
              <span className="self-center text-xs text-emerald-600">
                {reindexCount != null
                  ? `${reindexCount}개 재색인 완료`
                  : "완료"}
              </span>
            )}
          </div>
        </section>

        <TrashSection />

        <section className="mb-5">
          <h3 className="mb-2 text-sm font-semibold text-neutral-600">
            독서기록 책 선택 팝업
          </h3>
          <div className="flex gap-1.5 text-sm">
            {(
              [
                ["grid", "책장(표지)"],
                ["list", "목록"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                className={`rounded-md border px-3 py-1.5 ${
                  bookPickerView === v
                    ? "border-neutral-800 bg-neutral-50 font-medium"
                    : "border-neutral-200 text-neutral-500 hover:border-neutral-400"
                }`}
                onClick={() => setBookPickerView(v)}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        <section className="mb-5">
          <h3 className="mb-2 text-sm font-semibold text-neutral-600">삭제</h3>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.checked)}
            />
            <span>
              삭제 전 확인 단계 거치기
              <span className="block text-xs text-neutral-400">
                삭제는 항상 두 번 눌러야 하며, 끄면 마지막 [삭제 확인] 버튼만
                생략됩니다
              </span>
            </span>
          </label>
        </section>

        <HistorySection />

        <section className="mb-5">
          <h3 className="mb-1 text-sm font-semibold text-neutral-600">
            미러(백업) 폴더
          </h3>
          <p className="mb-2 text-xs text-neutral-400">
            저장할 때마다 vault를 이 폴더들로 자동 복제합니다. OneDrive·Google
            Drive 등 클라우드 동기화 폴더를 지정하면 자동 백업이 됩니다.
          </p>
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
                                className="rounded bg-white px-1.5 py-0.5 text-[10px] text-neutral-600 hover:bg-neutral-100"
                                onClick={() =>
                                  resolveMirrorConflict(m, rel, false)
                                }
                                title="vault 내용으로 미러를 덮어씁니다"
                              >
                                vault 우선
                              </button>
                              <button
                                className="rounded bg-white px-1.5 py-0.5 text-[10px] text-neutral-600 hover:bg-neutral-100"
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
        </section>

        <section className="mb-5">
          <h3 className="mb-1 text-sm font-semibold text-neutral-600">
            카카오 책 검색 API
          </h3>
          <p className="mb-2 text-xs text-neutral-400">
            키가 없어도 책 검색·자동 채우기는 교보문고로 동작합니다. 카카오 키를
            넣으면 검색 결과가 더 정확해집니다.{" "}
            <span className="text-neutral-500">developers.kakao.com</span>에서
            REST API 키를 무료로 발급받을 수 있습니다.
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 text-sm focus:border-neutral-500 focus:outline-none"
              placeholder="REST API 키"
              value={kakaoKey}
              onChange={(e) => setKakaoKey(e.target.value)}
            />
            <button
              className="shrink-0 rounded border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-500"
              onClick={saveKakaoKey}
            >
              저장
            </button>
            {keySaved && (
              <span className="self-center text-xs text-emerald-600">저장됨</span>
            )}
          </div>
        </section>

        <NoteTemplateSection />

        {customs.length > 0 && (
          <section className="mb-5">
            <h3 className="mb-2 text-sm font-semibold text-neutral-600">
              사용자 추가 분류
            </h3>
            <ul className="flex flex-col gap-1">
              {customs.map((s) => (
                <CustomTypeRow
                  key={s.id}
                  id={s.id}
                  label={s.label}
                  template={s.template}
                  onRemoved={removeCustom}
                  onTemplateSaved={removeCustom}
                />
              ))}
            </ul>
          </section>
        )}

        <div className="flex justify-end">
          <button
            className="rounded bg-neutral-800 px-4 py-1.5 text-sm text-white hover:bg-neutral-600"
            onClick={onClose}
          >
            닫기
          </button>
        </div>
    </Modal>
  );
}

const TRASH_RETENTION_OPTIONS: [number, string][] = [
  [0, "안 함 (직접 비울 때까지 보관)"],
  [7, "7일 지나면 자동 삭제"],
  [30, "30일 지나면 자동 삭제"],
];

/** 휴지통 — 복구는 별도 창에서, 여기선 열기 버튼과 자동삭제 설정만 */
function TrashSection() {
  const { trashRetentionDays, setTrashRetention } = useVault();
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    commands.listTrash().then((r) => {
      if (r.status === "ok") setCount(r.data.length);
    });
  }, []);

  return (
    <section className="mb-5">
      <h3 className="mb-2 text-sm font-semibold text-neutral-600">휴지통</h3>
      <div className="flex items-center gap-2">
        <button
          className="rounded border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-500"
          onClick={openTrashWindow}
        >
          휴지통 열기{count != null ? ` (${count}개)` : ""}
        </button>
        <select
          className="rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-500 focus:outline-none"
          value={trashRetentionDays}
          onChange={(e) => setTrashRetention(Number(e.target.value))}
          title="오래된 휴지통 항목을 자동으로 영구 삭제합니다"
        >
          {TRASH_RETENTION_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-1.5 text-xs text-neutral-400">
        삭제한 노트는 휴지통 창에서 원래 폴더로 되돌릴 수 있습니다.
      </p>
    </section>
  );
}

const HISTORY_MAX_OPTIONS: [number, string][] = [
  [0, "남기지 않음"],
  [5, "5개"],
  [20, "20개 (권장)"],
  [50, "50개"],
];

const HISTORY_INTERVAL_OPTIONS: [number, string][] = [
  [60, "1분"],
  [300, "5분 (권장)"],
  [1800, "30분"],
];

/** 편집 기록 — 저장 직전 스냅샷의 보관 정책과 비우기 */
function HistorySection() {
  const { historyMax, historyIntervalSecs, setHistoryPolicy } = useVault();
  const [purging, setPurging] = useState(false);
  const [purged, setPurged] = useState<number | null>(null);

  async function purge() {
    setPurging(true);
    const r = await commands.purgeHistory();
    setPurging(false);
    if (r.status === "ok") {
      setPurged(r.data);
      setTimeout(() => setPurged(null), 3000);
    }
  }

  return (
    <section className="mb-5">
      <h3 className="mb-1 text-sm font-semibold text-neutral-600">편집 기록</h3>
      <p className="mb-2 text-xs text-neutral-400">
        저장하기 직전의 내용을 남겨 두었다가, 편집기의 🕘 버튼으로 되돌릴 수
        있습니다. 내용이 크게 줄어드는 저장은 간격과 상관없이 항상 남깁니다.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-500 focus:outline-none"
          value={historyMax}
          onChange={(e) =>
            setHistoryPolicy(Number(e.target.value), historyIntervalSecs)
          }
          title="노트 하나당 보관할 기록 개수"
        >
          {HISTORY_MAX_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>
              노트당 {label}
            </option>
          ))}
        </select>
        <select
          className="rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-500 focus:outline-none disabled:opacity-40"
          value={historyIntervalSecs}
          disabled={historyMax === 0}
          onChange={(e) =>
            setHistoryPolicy(historyMax, Number(e.target.value))
          }
          title="이 시간이 지나야 새 기록을 남깁니다"
        >
          {HISTORY_INTERVAL_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>
              최소 간격 {label}
            </option>
          ))}
        </select>
        <button
          className="rounded border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-500 disabled:opacity-40"
          disabled={purging}
          onClick={purge}
        >
          {purging ? "비우는 중…" : "기록 모두 비우기"}
        </button>
        {purged != null && (
          <span className="text-xs text-emerald-600">{purged}개 삭제됨</span>
        )}
      </div>
    </section>
  );
}

/** 고급 — 데일리/자유노트 본문 템플릿 편집 (frontmatter는 건드리지 않음) */
function NoteTemplateSection() {
  const [open, setOpen] = useState(false);
  const [daily, setDaily] = useState("");
  const [free, setFree] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    if (!open || loaded) return;
    (async () => {
      const d = await commands.getNoteTemplate("daily");
      if (d.status === "ok") setDaily(d.data);
      const f = await commands.getNoteTemplate("free");
      if (f.status === "ok") setFree(f.data);
      setLoaded(true);
    })();
  }, [open, loaded]);

  async function save(kind: "daily" | "free", content: string) {
    const r = await commands.setNoteTemplate(kind, content);
    if (r.status === "ok") {
      setSaved(kind);
      setTimeout(() => setSaved(""), 2000);
    }
  }

  const taCls =
    "h-24 w-full resize-y rounded border border-neutral-300 px-2 py-1 font-mono text-xs focus:border-neutral-500 focus:outline-none";

  return (
    <section className="mb-5">
      <button
        className="text-sm font-semibold text-neutral-600 hover:text-neutral-800"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "▾" : "▸"} 고급 — 노트 템플릿
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-4">
          <div className="text-xs text-neutral-400">
            <p>
              새로 만드는 데일리·자유노트의 <b>본문</b> 템플릿입니다.
              frontmatter는 건드리지 않으며, 비워 두면 기본값으로 돌아갑니다.
            </p>
            <p className="mt-1">
              쓸 수 있는 자리표시자: <code>{"{{date}}"}</code>(2026-07-27){" "}
              <code>{"{{weekday}}"}</code>(월) <code>{"{{yesterday}}"}</code>{" "}
              <code>{"{{time}}"}</code>(09:30) <code>{"{{title}}"}</code>
            </p>
            <p className="mt-1">
              할 일 개수는 <b>내용이 있는</b> <code>- [ ]</code> 만 셉니다 —
              템플릿에 빈 체크박스를 넣어 두어도 숫자가 늘지 않습니다.
            </p>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-neutral-600">데일리노트</span>
              <span className="flex items-center gap-2">
                {saved === "daily" && (
                  <span className="text-xs text-emerald-600">저장됨</span>
                )}
                <button
                  className="rounded border border-neutral-300 px-2 py-0.5 text-xs hover:border-neutral-500"
                  onClick={() => save("daily", daily)}
                >
                  저장
                </button>
              </span>
            </div>
            <textarea
              className={taCls}
              value={daily}
              onChange={(e) => setDaily(e.target.value)}
              placeholder="## 할 일\n\n- [ ] \n\n## 기록\n"
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-neutral-600">자유노트</span>
              <span className="flex items-center gap-2">
                {saved === "free" && (
                  <span className="text-xs text-emerald-600">저장됨</span>
                )}
                <button
                  className="rounded border border-neutral-300 px-2 py-0.5 text-xs hover:border-neutral-500"
                  onClick={() => save("free", free)}
                >
                  저장
                </button>
              </span>
            </div>
            <textarea
              className={taCls}
              value={free}
              onChange={(e) => setFree(e.target.value)}
              placeholder="(기본은 빈 문서 — 원하는 템플릿을 넣어보세요)"
            />
          </div>
        </div>
      )}
    </section>
  );
}

function CustomTypeRow({
  id,
  label,
  template,
  onRemoved,
  onTemplateSaved,
}: {
  id: string;
  label: string;
  template: string;
  onRemoved: () => Promise<void>;
  onTemplateSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(template);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  async function remove() {
    setBusy(true);
    const { commands } = await import("../bindings");
    await commands.removeCustomType(id);
    await onRemoved();
    setBusy(false);
  }

  return (
    <li className="rounded border border-neutral-200 px-3 py-1.5 text-sm">
      <div className="flex items-center justify-between">
        <span>📁 {label}</span>
        <span className="flex items-center gap-2">
          <button
            className="text-xs text-neutral-500 hover:text-neutral-700"
            onClick={() => {
              setDraft(template);
              setEditing((v) => !v);
            }}
          >
            {editing ? "닫기" : "템플릿 수정"}
          </button>
          {confirming ? (
            <span className="flex items-center gap-1">
              <span className="text-[11px] text-neutral-400">
                노트는 자유노트로 이동
              </span>
              <button
                className="rounded bg-rose-600 px-2 py-0.5 text-xs font-bold text-white hover:bg-rose-500 disabled:opacity-50"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  remove();
                }}
              >
                제거 확인
              </button>
              <button
                className="rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100"
                onClick={() => setConfirming(false)}
              >
                취소
              </button>
            </span>
          ) : (
            <button
              className="text-xs text-rose-400 hover:text-rose-600 disabled:opacity-50"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              제거
            </button>
          )}
        </span>
      </div>
      {editing && (
        <div className="mt-2 flex flex-col gap-1.5">
          <p className="text-[11px] text-neutral-400">
            이 분류로 새로 만드는 노트의 본문 템플릿입니다. frontmatter는 건드리지
            않습니다. <code>{"{{date}}"}</code>, <code>{"{{title}}"}</code> 사용
            가능. 이미 만든 노트에는 영향을 주지 않습니다.
          </p>
          <textarea
            className="h-24 w-full resize-y rounded border border-neutral-300 px-2 py-1 font-mono text-xs focus:border-neutral-500 focus:outline-none"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <button
              className="self-start rounded bg-neutral-800 px-3 py-1 text-xs text-white hover:bg-neutral-600 disabled:opacity-50"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const { commands } = await import("../bindings");
                const r = await commands.updateCustomTypeTemplate(id, draft);
                if (r.status === "ok") {
                  await onTemplateSaved();
                  setSaved(true);
                  setTimeout(() => setSaved(false), 2000);
                }
                setBusy(false);
              }}
            >
              저장
            </button>
            {saved && <span className="text-xs text-emerald-600">저장됨</span>}
          </div>
        </div>
      )}
    </li>
  );
}
