import { useEffect, useMemo, useState } from "react";
import { load } from "@tauri-apps/plugin-store";
import { commands } from "../bindings";
import {
  DEFAULT_DAILY_KIND_ORDER,
  useVault,
  type LayoutMode,
} from "../stores/vault";
import { styleOf } from "../lib/callouts";
import { isImeEnter, useImeInput } from "../lib/ime";
import { IS_MAC, SHORTCUTS, shortcutText } from "../lib/shortcuts";
import { dailyKindOptions } from "./DailyEntryBar";
import HelpSection from "./HelpSection";
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
              각 분류로 새로 만드는 노트의 본문 템플릿입니다. frontmatter는
              건드리지 않으며, 이미 만든 노트에는 영향을 주지 않습니다.{" "}
              <code>{"{{date}}"}</code>, <code>{"{{title}}"}</code> 등의 자리표시자를
              쓸 수 있습니다.
            </p>
            <ul className="flex flex-col gap-2">
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

const PALETTE = [
  "red", "orange", "yellow", "lime", "emerald",
  "sky", "indigo", "violet", "rose", "neutral", "black",
] as const;
const PALETTE_LABEL: Record<string, string> = {
  red: "빨강", orange: "주황", yellow: "노랑", lime: "연두",
  emerald: "초록", sky: "하늘", indigo: "남색", violet: "보라",
  rose: "분홍", neutral: "회색", black: "검정",
  // 아래는 기본 콜아웃·기존 설정이 쓰던 색 (새로 고를 수는 없다)
  amber: "호박", teal: "청록", blue: "파랑", fuchsia: "자주", stone: "갈회",
};
// 문장처럼 읽히도록: "[데일리노트에] [아이콘] [이름] 추가"
const SCOPES: [string, string][] = [
  ["daily", "데일리노트에"],
  ["book", "독서기록에"],
  ["both", "둘 다에"],
];
/** 목록에 짧게 표시할 이름 */
const SCOPE_SHORT: Record<string, string> = {
  daily: "데일리노트",
  book: "독서기록",
  both: "둘 다",
};
/** 고를 수 있는 아이콘 (맨 앞은 '없음') */
const ICONS = [
  "",
  "📌","💭","📋","❓","🕘","💛","🔖","⭐","✅","📖",
  "✍️","💡","🔥","🌱","🎯","🧩","📎","🗒️","🔔","💬",
  "📝","🗓️","⏰","🏷️","🔍","📊","📈","🧠","🫀","👍",
  "👎","⚠️","❗","‼️","❤️","🧡","💚","💙","💜","🤍",
  "🌟","✨","🌈","☀️","🌙","☁️","🌊","🍀","🌸","🍂",
  "🎵","🎬","🎨","🏃","🍽️","☕","🛏️","💊","💰","🎁",
]; 

/** 단축키 목록 + 개별 켜고 끄기.
 *  키 조합을 바꾸는 기능은 아직 없다 — 목록 자체가 단축키 안내서 역할도 한다. */
function ShortcutSection() {
  const shortcutsOff = useVault((s) => s.shortcutsOff);
  const toggleShortcut = useVault((s) => s.toggleShortcut);

  return (
    <section className="mb-5">
      <h3 className="mb-1 text-sm font-semibold text-neutral-600">단축키</h3>
      <p className="mb-2 text-xs text-neutral-400">
        {IS_MAC ? "맥에서는 ⌘" : "윈도우·리눅스에서는 Ctrl"}을 씁니다. 다른 앱과
        겹치면 개별로 끌 수 있습니다.
      </p>
      <ul className="flex flex-col gap-1">
        {SHORTCUTS.map((s) => {
          const on = !shortcutsOff.includes(s.id);
          return (
            <li key={s.id}>
              <label className="flex cursor-pointer items-center gap-2.5 rounded-md border border-neutral-200 px-3 py-1.5 hover:border-neutral-400">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleShortcut(s.id)}
                />
                <kbd
                  className={`shrink-0 rounded border px-2 py-0.5 font-mono text-xs ${
                    on
                      ? "border-neutral-300 bg-neutral-50 text-neutral-700"
                      : "border-neutral-200 bg-neutral-50 text-neutral-300 line-through"
                  }`}
                >
                  {shortcutText(s)}
                </kbd>
                <span className="min-w-0 text-sm">
                  <span className={on ? "" : "text-neutral-400"}>{s.label}</span>
                  <span className="block text-2xs text-neutral-400">
                    {s.hint}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** 일지 빠른 입력 바의 버튼 순서 — ▲▼로 바꾸면 그 자리에서 저장된다.
 *  맨 앞에 둔 종류가 일지를 열었을 때 기본으로 선택된다. */
function DailyKindOrderSection() {
  const callouts = useVault((s) => s.callouts);
  const order = useVault((s) => s.dailyKindOrder);
  const setDailyKindOrder = useVault((s) => s.setDailyKindOrder);

  const options = useMemo(
    () =>
      dailyKindOptions(
        callouts.filter((c) => c.scope === "daily" || c.scope === "both"),
        order,
      ),
    [callouts, order],
  );

  /** 화면에 보이는 순서를 그대로 저장한다 (지금 없는 종류는 목록에서 빠진다) */
  function move(index: number, delta: -1 | 1) {
    const next = options.map((o) => o.key);
    const to = index + delta;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    setDailyKindOrder(next);
  }

  const isDefault =
    options.map((o) => o.key).join() ===
    dailyKindOptions(
      callouts.filter((c) => c.scope === "daily" || c.scope === "both"),
      DEFAULT_DAILY_KIND_ORDER,
    )
      .map((o) => o.key)
      .join();

  return (
    <section className="mb-5">
      <h3 className="mb-1 text-sm font-semibold text-neutral-600">
        일지 빠른 입력 순서
      </h3>
      <p className="mb-2 text-xs text-neutral-400">
        데일리노트 입력 바의 버튼 순서입니다. 맨 위에 둔 종류가 기본으로
        선택됩니다.
      </p>
      <ul className="flex flex-col gap-1">
        {options.map((o, i) => (
          <li key={o.key} className="flex items-center gap-1.5">
            <span
              className={`min-w-20 rounded-md border border-current/10 px-3 py-1 text-center text-sm font-medium ${o.active}`}
            >
              {o.icon ? `${o.icon} ` : ""}
              {o.label}
            </span>
            <button
              className="rounded border border-neutral-300 px-1.5 py-0.5 text-xs text-neutral-600 hover:border-neutral-500 disabled:opacity-30"
              disabled={i === 0}
              onClick={() => move(i, -1)}
              title="위로"
            >
              ▲
            </button>
            <button
              className="rounded border border-neutral-300 px-1.5 py-0.5 text-xs text-neutral-600 hover:border-neutral-500 disabled:opacity-30"
              disabled={i === options.length - 1}
              onClick={() => move(i, 1)}
              title="아래로"
            >
              ▼
            </button>
          </li>
        ))}
      </ul>
      {!isDefault && (
        <button
          className="mt-2 rounded border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600 hover:border-neutral-500"
          onClick={() => setDailyKindOrder(DEFAULT_DAILY_KIND_ORDER)}
        >
          기본 순서로
        </button>
      )}
    </section>
  );
}

/** 사용자 정의 콜아웃 — 일지·책 각각 5개까지 */
function CalloutSection() {
  const { callouts, refreshCallouts } = useVault();
  const [icon, setIcon] = useState("");
  const [color, setColor] = useState<string>("rose");
  const [scope, setScope] = useState("daily");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  async function add(value?: string) {
    const name = (value ?? addIme.value()).trim();
    if (busy || !name) return;
    setBusy(true);
    setError("");
    const r = await commands.addCallout({
      label: name,
      icon,
      color,
      scope,
    });
    if (r.status === "ok") {
      addIme.clear();
      await refreshCallouts();
    } else {
      setError(r.error);
    }
    setBusy(false);
  }

  const addIme = useImeInput((v) => add(v), "enter");

  async function remove(l: string) {
    setBusy(true);
    setConfirming(null);
    const r = await commands.removeCallout(l);
    if (r.status === "ok") await refreshCallouts();
    else setError(r.error);
    setBusy(false);
  }

  return (
    <section className="mb-5">
      <h3 className="mb-1 text-sm font-semibold text-neutral-600">기록 종류 추가</h3>
      <p className="mb-2 text-xs text-neutral-400">
        일지·책에서 쓸 기록 종류를 직접 만들 수 있습니다. 화면마다 5개까지이고,
        만든 종류는 vault에 저장돼 다른 기기에서도 그대로 보입니다.
      </p>

      {callouts.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1">
          {callouts.map((c) => (
            <li
              key={c.label}
              className={`flex items-center justify-between rounded border px-3 py-1.5 text-xs ${styleOf(
                c.color as never,
              ).card}`}
            >
              <span>
                {c.icon && `${c.icon} `}
                {c.label}
                <span className="ml-2 opacity-60">
                  {SCOPE_SHORT[c.scope] ?? c.scope} ·{" "}
                  {PALETTE_LABEL[c.color] ?? c.color}
                </span>
              </span>
              {confirming === c.label ? (
                <span className="flex shrink-0 items-center gap-1">
                  <span className="text-3xs opacity-70">
                    이미 쓴 기록은 남습니다
                  </span>
                  <button
                    className="rounded bg-rose-600 px-1.5 py-0.5 text-2xs font-bold text-white hover:bg-rose-500 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => remove(c.label)}
                  >
                    제거 확인
                  </button>
                  <button
                    className="rounded px-1 py-0.5 text-2xs opacity-70 hover:bg-white/60"
                    onClick={() => setConfirming(null)}
                  >
                    취소
                  </button>
                </span>
              ) : (
                <button
                  className="shrink-0 text-rose-400 hover:text-rose-600 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => setConfirming(c.label)}
                  title="목록에서만 뺍니다 — 이미 쓴 기록은 그대로 남습니다"
                >
                  제거
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <select
          className="rounded border border-neutral-300 px-1.5 py-1 text-xs"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          {SCOPES.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>

        {/* 아이콘: 지금 고른 것만 보여주고 누르면 펼친다 */}
        <div className="relative">
          <button
            className="h-7 w-10 rounded border border-neutral-300 text-sm hover:border-neutral-500"
            onClick={() => {
              setIconOpen((v) => !v);
              setColorOpen(false);
            }}
            title="아이콘 고르기"
          >
            {icon || <span className="text-3xs text-neutral-400">없음</span>}
          </button>
          {iconOpen && (
            <div className="absolute left-0 z-10 mt-1 flex max-h-56 w-[17rem] flex-wrap gap-1 overflow-y-auto rounded-md border border-neutral-200 bg-white p-2 shadow-lg">
              {ICONS.map((ic) => (
                <button
                  key={ic || "none"}
                  className={`h-7 w-7 rounded border text-sm ${
                    icon === ic
                      ? "border-neutral-800 bg-neutral-100"
                      : "border-transparent hover:border-neutral-300"
                  }`}
                  onClick={() => {
                    setIcon(ic);
                    setIconOpen(false);
                  }}
                  title={ic || "없음"}
                >
                  {ic || <span className="text-3xs text-neutral-400">없음</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <input
          className="w-24 rounded border border-neutral-300 px-2 py-1 text-sm focus:border-neutral-500 focus:outline-none"
          placeholder="이름"
          defaultValue=""
          {...addIme.handlers}
        />

        {/* 색: 지금 고른 색만 보여주고 누르면 펼친다 */}
        <div className="relative">
          <button
            className={`rounded border px-2.5 py-1 text-xs ${styleOf(color as never).card}`}
            onClick={() => {
              setColorOpen((v) => !v);
              setIconOpen(false);
            }}
            title="색 고르기"
          >
            {PALETTE_LABEL[color] ?? color}
          </button>
          {colorOpen && (
            <div className="absolute right-0 z-10 mt-1 grid w-[17rem] grid-cols-3 gap-1 rounded-md border border-neutral-200 bg-white p-2 shadow-lg">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  className={`rounded border px-2 py-1 text-center text-xs ${styleOf(c).card} ${
                    color === c ? "ring-2 ring-neutral-800" : ""
                  }`}
                  onClick={() => {
                    setColor(c);
                    setColorOpen(false);
                  }}
                >
                  {PALETTE_LABEL[c] ?? c}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          className="rounded bg-neutral-800 px-3 py-1 text-xs text-white hover:bg-neutral-600 disabled:opacity-50"
          disabled={busy}
          onClick={() => add()}
        >
          추가
        </button>
      </div>
      {error && <p className="mt-1.5 text-xs text-rose-500">{error}</p>}
    </section>
  );
}

const TRASH_RETENTION_OPTIONS: [number, string][] = [
  [0, "안 함 (직접 비울 때까지 보관)"],
  [7, "7일 지나면 자동 삭제"],
  [30, "30일 지나면 자동 삭제"],
];

/** 휴지통 자동 비우기 — 휴지통 자체는 사이드바 🗑️ 링크로 연다 */
function TrashSection() {
  const { trashRetentionDays, setTrashRetention } = useVault();

  return (
    <section className="mb-5">
      <h3 className="mb-2 text-sm font-semibold text-neutral-600">
        휴지통 자동 비우기
      </h3>
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
      <p className="mt-1.5 text-xs text-neutral-400">
        휴지통 자체는 왼쪽 아래 <b>🗑️ 휴지통</b>에서 열 수 있습니다.
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

/** 고급 — 노트 본문 템플릿 편집에서 다루는 내장 종류들 */
const NOTE_TEMPLATE_KINDS: { id: string; label: string; placeholder: string }[] = [
  { id: "daily", label: "데일리노트", placeholder: "## 할 일\n\n- [ ] \n\n## 기록\n" },
  {
    id: "free",
    label: "자유노트",
    placeholder: "(기본은 빈 문서 — 원하는 템플릿을 넣어보세요)",
  },
  { id: "info", label: "정보노트", placeholder: "## 요약\n\n## 내용\n\n## 메모\n" },
  {
    id: "writing",
    label: "글쓰기",
    placeholder: "(기본은 빈 문서 — 원고를 바로 씁니다)",
  },
];

/** 라벨 + textarea + 저장 버튼 + 미리보기 — 본문 템플릿 편집이 공유하는 모양 */
function TemplateEditor({
  label,
  value,
  placeholder,
  saved,
  onChange,
  onSave,
}: {
  label: string;
  value: string;
  placeholder?: string;
  saved: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-600">{label}</span>
        <span className="flex items-center gap-2">
          {saved && <span className="text-xs text-emerald-600">저장됨</span>}
          <button
            className="rounded border border-neutral-300 px-2 py-0.5 text-xs hover:border-neutral-500"
            onClick={onSave}
          >
            저장
          </button>
        </span>
      </div>
      <textarea
        className="h-24 w-full resize-y rounded border border-neutral-300 px-2 py-1 font-mono text-xs focus:border-neutral-500 focus:outline-none"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <TemplatePreview content={value} />
    </div>
  );
}

/** 고급 — 내장 노트 종류들의 본문 템플릿 편집 (frontmatter는 건드리지 않음) */
function NoteTemplateSection() {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    if (!open || loaded) return;
    (async () => {
      const next: Record<string, string> = {};
      for (const k of NOTE_TEMPLATE_KINDS) {
        const r = await commands.getNoteTemplate(k.id);
        next[k.id] = r.status === "ok" ? r.data : "";
      }
      setValues(next);
      setLoaded(true);
    })();
  }, [open, loaded]);

  async function save(kind: string) {
    const r = await commands.setNoteTemplate(kind, values[kind] ?? "");
    if (r.status === "ok") {
      setSaved(kind);
      setTimeout(() => setSaved(""), 2000);
    }
  }

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
              새로 만드는 노트의 <b>본문</b> 템플릿입니다. frontmatter는
              건드리지 않으며, 비워 두면 기본값으로 돌아갑니다.
            </p>
            <p className="mt-1">
              쓸 수 있는 자리표시자:{" "}
              {[
                ["{{date}}", "2026-07-30"],
                ["{{weekday}}", "목"],
                ["{{yesterday}}", "어제"],
                ["{{tomorrow}}", "내일"],
                ["{{month}}", "2026-07"],
                ["{{year}}", "2026"],
                ["{{week}}", "31주"],
                ["{{time}}", "09:30"],
                ["{{title}}", "제목"],
              ].map(([k, v]) => (
                <code key={k} className="mr-1.5 whitespace-nowrap">
                  {k}
                  <span className="text-neutral-300">({v})</span>
                </code>
              ))}
            </p>
            <p className="mt-1">
              모르는 자리표시자는 그대로 남습니다 — 오타를 바로 알아챌 수 있게요.
            </p>
            <p className="mt-1">
              할 일 개수는 <b>내용이 있는</b> <code>- [ ]</code> 만 셉니다 —
              템플릿에 빈 체크박스를 넣어 두어도 숫자가 늘지 않습니다.
            </p>
          </div>
          {NOTE_TEMPLATE_KINDS.map((k) => (
            <TemplateEditor
              key={k.id}
              label={k.label}
              value={values[k.id] ?? ""}
              placeholder={k.placeholder}
              saved={saved === k.id}
              onChange={(v) => setValues((s) => ({ ...s, [k.id]: v }))}
              onSave={() => save(k.id)}
            />
          ))}

          <TitlePrefixSection />
        </div>
      )}
    </section>
  );
}

/** 제목 머릿글 — 새 노트의 제목 앞에 자동으로 붙는 글 (예: "{{date}} ") */
function TitlePrefixSection() {
  const schemas = useVault((s) => s.schemas);
  // 파일명 규칙이 확고한 책·글쓰기·데일리는 대상이 아니다
  const targets = schemas.filter(
    (s) => !["book", "writing", "daily"].includes(s.id),
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    if (loaded || targets.length === 0) return;
    (async () => {
      const next: Record<string, string> = {};
      for (const t of targets) {
        const r = await commands.getTitleTemplate(t.id);
        next[t.id] = r.status === "ok" ? r.data : "";
      }
      setDrafts(next);
      setLoaded(true);
    })();
  }, [loaded, targets]);

  async function save(id: string) {
    const r = await commands.setTitleTemplate(id, drafts[id] ?? "");
    if (r.status === "ok") {
      setSaved(id);
      setTimeout(() => setSaved(""), 2000);
    }
  }

  if (targets.length === 0) return null;

  return (
    <div className="border-t border-neutral-100 pt-3">
      <p className="mb-1 text-xs font-medium text-neutral-600">제목 머릿글</p>
      <p className="mb-2 text-xs text-neutral-400">
        새 노트를 만들 때 제목 앞에 자동으로 붙는 글입니다. 예를 들어{" "}
        <code>{"{{date}} "}</code>를 넣으면 제목이{" "}
        <b>2026-07-27 회의록</b>처럼 만들어집니다. 끝의 공백도 그대로 쓰이니
        띄어쓰기를 잊지 마세요.
      </p>
      <div className="flex flex-col gap-1.5">
        {targets.map((t) => (
          <div key={t.id} className="flex items-center gap-2">
            <span className="w-20 shrink-0 truncate text-xs text-neutral-500">
              {t.label}
            </span>
            <input
              className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 font-mono text-xs focus:border-neutral-500 focus:outline-none"
              placeholder="(머릿글 없음)"
              value={drafts[t.id] ?? ""}
              onChange={(e) =>
                setDrafts((d) => ({ ...d, [t.id]: e.target.value }))
              }
              onKeyDown={(e) => e.key === "Enter" && !isImeEnter(e) && save(t.id)}
            />
            {saved === t.id && (
              <span className="shrink-0 text-xs text-emerald-600">저장됨</span>
            )}
            <button
              className="shrink-0 rounded border border-neutral-300 px-2 py-0.5 text-xs hover:border-neutral-500"
              onClick={() => save(t.id)}
            >
              저장
            </button>
          </div>
        ))}
      </div>
    </div>
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

  async function save() {
    setBusy(true);
    const { commands } = await import("../bindings");
    const r = await commands.updateCustomTypeTemplate(id, draft);
    if (r.status === "ok") {
      await onTemplateSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
    setBusy(false);
  }

  return (
    <li className="rounded border border-neutral-200 px-3 py-2 text-sm">
      <div className="mb-1.5 flex items-center justify-between">
        <span>📁 {label}</span>
        {confirming ? (
          <span className="flex items-center gap-1">
            <span className="text-2xs text-neutral-400">
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
      </div>
      <TemplateEditor
        label="본문 템플릿"
        value={draft}
        saved={saved}
        onChange={setDraft}
        onSave={save}
      />
    </li>
  );
}

/** 템플릿 미리보기 — 화면에서 직접 치환하지 않고 백엔드를 거친다.
 *  노트를 실제로 만들 때와 같은 함수를 써야 미리보기가 거짓말을 하지 않는다. */
function TemplatePreview({ content }: { content: string }) {
  const [out, setOut] = useState("");

  useEffect(() => {
    if (!content.trim()) {
      setOut("");
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      const r = await commands.previewTemplate(content, "");
      if (alive && r.status === "ok") setOut(r.data);
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [content]);

  if (!out) return null;
  return (
    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded border border-neutral-200 bg-neutral-50 px-2 py-1 text-2xs leading-relaxed text-neutral-600">
      {out}
    </pre>
  );
}
