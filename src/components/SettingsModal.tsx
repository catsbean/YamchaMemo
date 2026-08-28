import { useEffect, useState } from "react";
import { load } from "@tauri-apps/plugin-store";
import { useVault, type LayoutMode } from "../stores/vault";
import HelpSection from "./HelpSection";
import Modal from "./Modal";
import CalloutSection from "./settings/CalloutSection";
import CustomTypeRow from "./settings/CustomTypeRow";
import DailyKindOrderSection from "./settings/DailyKindOrderSection";
import HistorySection from "./settings/HistorySection";
import LinkSection from "./settings/LinkSection";
import NoteTemplateSection from "./settings/NoteTemplateSection";
import ScrapTypeSection from "./settings/ScrapTypeSection";
import ShortcutSection from "./settings/ShortcutSection";
import StartupSection from "./settings/StartupSection";
import TodoTabSection from "./settings/TodoTabSection";
import TrashSection from "./settings/TrashSection";
import VersionSection from "./settings/VersionSection";

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

const TABS = [
  { id: "general", label: "일반" },
  { id: "record", label: "기록" },
  { id: "storage", label: "저장" },
  { id: "etc", label: "연동" },
  { id: "help", label: "도움말" },
] as const;

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<string>("general");
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
    quickCaptureOn,
    setQuickCaptureOn,
    quickCaptureShortcut,
    setQuickCaptureShortcut,
    captureError,
    bookPickerView,
    setBookPickerView,
    theme,
    setTheme,
  } = useVault();
  const [syncing, setSyncing] = useState(false);
  const [captureHelp, setCaptureHelp] = useState(false);
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
      panelClassName="flex h-[38rem] max-h-[88vh] w-[32rem] flex-col rounded-lg p-5 shadow-xl"
    >
        <h2 className="mb-3 text-base font-bold">설정</h2>
        <div className="mb-4 flex gap-1 border-b border-neutral-200">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
                tab === t.id
                  ? "border-neutral-800 font-medium text-neutral-800"
                  : "border-transparent text-neutral-400 hover:text-neutral-600"
              }`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1">
        {tab === "general" && (
          <>
        <section className="mb-5">
          <h3 className="mb-2 text-sm font-semibold text-neutral-600">화면 밝기</h3>
          <div className="flex gap-1.5 text-sm">
            {(
              [
                ["light", "라이트", "밝은 화면"],
                ["dark", "다크", "어두운 화면"],
                ["system", "시스템 설정", "운영체제를 따릅니다"],
              ] as const
            ).map(([v, label, desc]) => (
              <button
                key={v}
                className={`flex-1 rounded-md border px-3 py-2 text-left ${
                  theme === v
                    ? "border-neutral-800 bg-neutral-50 font-medium"
                    : "border-neutral-200 text-neutral-500 hover:border-neutral-400"
                }`}
                onClick={() => setTheme(v)}
              >
                <span className="block">{label}</span>
                <span className="block text-2xs text-neutral-400">{desc}</span>
              </button>
            ))}
          </div>
        </section>
        <StartupSection />
        <TodoTabSection />
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
        <LinkSection />
        <ShortcutSection />
        <section className="mb-5">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-neutral-600">
            빠른 담기
            <button
              className="flex h-4 w-4 items-center justify-center rounded-full border border-neutral-300 text-2xs text-neutral-500 hover:bg-neutral-100"
              title="이 기능이 무엇인지 보기"
              onClick={() => setCaptureHelp((v) => !v)}
            >
              ?
            </button>
          </h3>
          {captureHelp && (
            <p className="mb-2 rounded bg-neutral-50 p-2.5 text-xs leading-relaxed text-neutral-600">
              다른 프로그램을 쓰는 중에도 단축키 한 번으로 작은 입력창을 띄워, 지금
              떠오른 것이나 복사해 둔 것을 앱을 열지 않고 바로 담습니다. 담긴 것은
              아래에서 고른 곳에 한 줄로 쌓입니다.
              <br />
              꺼 두면 단축키를 쓰지 않으므로 다른 프로그램의 단축키와 부딪히지 않습니다.
            </p>
          )}
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={quickCaptureOn}
              onChange={(e) => setQuickCaptureOn(e.target.checked)}
            />
            <span>단축키로 어디서든 담기</span>
          </label>
          {captureError && (
            <p className="mt-1.5 text-xs text-rose-600">{captureError}</p>
          )}
          {quickCaptureOn && (
            <div className="mt-2 space-y-2 pl-6">
              <label className="flex items-center gap-2 text-xs text-neutral-600">
                단축키
                <input
                  className="w-56 rounded border border-neutral-300 px-2 py-0.5 text-xs focus:border-neutral-500 focus:outline-none"
                  value={quickCaptureShortcut}
                  onChange={(e) => setQuickCaptureShortcut(e.target.value)}
                />
              </label>
            </div>
          )}
        </section>
        <ScrapTypeSection />
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
                노트 삭제는 [삭제] → [삭제 확인] 두 번을 누릅니다. 끄면 확인
                버튼 대신 [삭제]를 한 번 더 누르는 방식이 됩니다
              </span>
            </span>
          </label>
        </section>
        <VersionSection />
          </>
        )}

        {tab === "record" && (
          <>
        <CalloutSection />
        <DailyKindOrderSection />
        <NoteTemplateSection />

        {tab === "record" && customs.length > 0 && (
          <section className="mb-5">
            <h3 className="mb-2 text-sm font-semibold text-neutral-600">
              사용자 추가 분류
            </h3>
            <p className="mb-2 text-xs text-neutral-400">
              분류마다 <b>목록에 함께 보일 칸</b>과 새 노트의 <b>본문 템플릿</b>을
              정합니다. 켠 칸은 그 분류의 목록에서 제목 옆에 값이 붙습니다(날짜·태그는
              늘 보이므로 고르는 대상이 아닙니다). 템플릿은 frontmatter를 건드리지
              않으며 이미 만든 노트에도 영향을 주지 않습니다 —{" "}
              <code>{"{{date}}"}</code>, <code>{"{{title}}"}</code> 등의 자리표시자를
              쓸 수 있습니다.
            </p>
            <ul className="flex flex-col gap-2">
              {customs.map((s) => (
                <CustomTypeRow
                  key={s.id}
                  id={s.id}
                  label={s.label}
                  fields={s.fields}
                  template={s.template}
                  onRemoved={removeCustom}
                  onTemplateSaved={removeCustom}
                />
              ))}
            </ul>
          </section>
        )}
          </>
        )}

        {tab === "storage" && (
          <>
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
        </section>
        <TrashSection />
        <HistorySection />
          </>
        )}

        {tab === "etc" && (
          <>
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
          </>
        )}

        {tab === "help" && <HelpSection />}

        </div>

        <div className="flex justify-end border-t border-neutral-100 pt-3">
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

