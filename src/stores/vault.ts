import { create } from "zustand";
import { load } from "@tauri-apps/plugin-store";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { notifyOtherWindows } from "../lib/windowSync";
import {
  DEFAULT_CAPTURE_SHORTCUT,
  disableCapture,
  enableCapture,
} from "../lib/quickCapture";
import {
  commands,
  type DailyKind,
  type CalloutDef,
  type EntryKind,
  type FieldDef,
  type IssueKind,
  type JsonValue,
  type MirrorReport,
  type NoteContent,
  type NoteIssue,
  type NoteSummary,
  type Result,
  type TypeDef,
} from "../bindings";

function unwrap<T>(r: Result<T, string>): T {
  if (r.status === "error") throw new Error(r.error);
  return r.data;
}

async function settings() {
  return await load("settings.json", { autoSave: true, defaults: {} });
}

type FmObject = { [key: string]: JsonValue | undefined };

/** 편집 시 목록(대시보드) 표시 방식 */
export type LayoutMode = "replace" | "three" | "vertical";

/** 화면 밝기 — 기본은 라이트. system은 OS 설정을 따른다. */
export type ThemeMode = "light" | "dark" | "system";

/** 앱 시작시 열 화면. home=항상 홈, last=종료 시 보던 화면,
 *  tab=지정한 메뉴, note=지정한 글. */
export type StartupMode = "home" | "last" | "tab" | "note";

/** 고른 모드를 실제 화면에 입힌다 (다크일 때만 <html>에 .dark를 붙인다) */
export function applyTheme(mode: ThemeMode) {
  const dark =
    mode === "dark" ||
    (mode === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

/** 일지 빠른 입력 바의 기본 순서 — 기록 · 느낌 · 할 일, 사용자 정의는 그 뒤 */
export const DEFAULT_DAILY_KIND_ORDER = ["log", "feeling", "todo"];

interface VaultStore {
  /** 사이드바에서 선택된 섹션 — current가 없으면 이 타입의 대시보드가 열린다 */
  nav: string;
  setNav(t: string): Promise<void>;
  vaultPath: string | null;
  schemas: TypeDef[];
  notes: NoteSummary[];
  current: NoteContent | null;
  dirty: boolean;
  error: string | null;
  initialized: boolean;
  layout: LayoutMode;
  /** 삭제 전 2단계 확인 여부 */
  deleteConfirm: boolean;
  setDeleteConfirm(v: boolean): Promise<void>;
  /** 독서기록 새로만들기 시 책 선택 팝업 표시 방식 */
  bookPickerView: "grid" | "list";
  setBookPickerView(v: "grid" | "list"): Promise<void>;
  /** 휴지통 자동삭제 보존 일수 (0 = 안 함) */
  trashRetentionDays: number;
  setTrashRetention(days: number): Promise<void>;
  /** 일지에서 할 일을 아래에 둘지 오른쪽에 둘지 */
  todoPanel: "bottom" | "right";
  setTodoPanel(v: "bottom" | "right"): Promise<void>;
  /** 할 일 구역을 크게 볼지 (기록 영역과 비율을 뒤집는다) */
  todoBig: boolean;
  toggleTodoBig(): Promise<void>;
  /** 빠른 담기 — 전역 단축키로 작은 창을 띄워 앱을 열지 않고 담는다 (기본 꺼짐) */
  quickCaptureOn: boolean;
  quickCaptureShortcut: string;
  /** 단축키를 걸지 못한 사유 (다른 프로그램과 충돌 등). 없으면 null */
  captureError: string | null;
  setQuickCaptureOn(v: boolean): Promise<void>;
  setQuickCaptureShortcut(s: string): Promise<void>;
  /** 회고에 독서기록도 함께 볼지 (회고 화면 토글) */
  reviewShowReading: boolean;
  toggleReviewShowReading(): Promise<void>;
  /** 검색에서 오타·초성을 견딜지 (검색창 토글) */
  searchFuzzy: boolean;
  toggleSearchFuzzy(): Promise<void>;
  /** 첨부 문서(pdf·hwp·오피스) 본문까지 찾을지 (검색창 토글) */
  searchInFiles: boolean;
  toggleSearchInFiles(): Promise<void>;
  /** 일지 빠른 입력 바의 종류 순서 — 기본 종류는 DailyKind 값, 사용자 정의는 그 이름.
   *  여기 없는 종류(나중에 만든 것)는 뒤에 붙는다. */
  dailyKindOrder: string[];
  setDailyKindOrder(order: string[]): Promise<void>;
  /** 화면 밝기 (기본 라이트) */
  theme: ThemeMode;
  setTheme(mode: ThemeMode): Promise<void>;
  /** 앱 시작시 열 화면 (기본은 마지막 화면 — 기존 동작 유지) */
  startupMode: StartupMode;
  setStartupMode(mode: StartupMode): Promise<void>;
  /** startupMode가 "tab"일 때 열 메뉴 id */
  startupTabId: string | null;
  setStartupTabId(id: string): Promise<void>;
  /** startupMode가 "note"일 때 열 노트의 rel_path */
  startupNoteRel: string | null;
  setStartupNoteRel(rel: string): Promise<void>;
  /** 지정한 시작 탭/글을 못 찾아 대신 홈을 연 이유 — 잠깐 보여주고 지운다 */
  startupNotice: string | null;
  dismissStartupNotice(): void;
  /** 꺼 둔 단축키 id 목록 (기본은 전부 켬) */
  shortcutsOff: string[];
  toggleShortcut(id: string): Promise<void>;
  /** "새 노트" 요청 신호 — 올라갈 때마다 지금 보이는 대시보드가 만들기 창을 연다.
   *  단축키는 편집기가 열려 있어도 눌리는데 만들기 창은 대시보드가 들고 있어서,
   *  편집기를 닫고 신호만 올린 뒤 대시보드가 받도록 한다. */
  createTick: number;
  requestCreate(): void;
  /** vault에 저장된 사용자 정의 콜아웃 */
  callouts: CalloutDef[];
  refreshCallouts(): Promise<void>;
  /** 미러 대상 폴더들 */
  mirrors: string[];
  /** 마지막 미러 동기화 결과 */
  mirrorReports: MirrorReport[];
  /** 열려 있는 노트가 외부에서 수정됨 (dirty 상태라 자동 리로드 못한 경우) */
  externalChanged: boolean;
  /** 규격에서 벗어난 노트들 (외부 편집기로 만들어졌거나 고쳐진 파일) */
  issues: NoteIssue[];
  refreshIssues(): Promise<void>;
  /** 점검 항목 한 건 수리 — 성공하면 true */
  fixIssue(relPath: string, kind: IssueKind): Promise<boolean>;
  /** 스냅샷 보관 정책 */
  historyMax: number;
  historyIntervalSecs: number;
  setHistoryPolicy(max: number, intervalSecs: number): Promise<void>;

  init(): Promise<void>;
  chooseVault(): Promise<void>;
  /** 감지된 위치 등 base 폴더 아래 YamchaMemo로 바로 시작 */
  startAt(base: string): Promise<void>;
  refresh(): Promise<void>;
  refreshSchemas(): Promise<void>;
  setLayout(mode: LayoutMode): Promise<void>;
  openNote(relPath: string): Promise<void>;
  closeNote(): void;
  setBody(body: string): void;
  setFrontmatter(fm: FmObject): void;
  saveCurrent(): Promise<void>;
  createNote(t: string, title: string, fields: FmObject): Promise<void>;
  /** 제목 없이 바로 만들어 편집기를 연다 (제목은 편집기 제목칸에서 입력) */
  createUntitled(t: string): Promise<void>;
  /** 방금 만들어 아직 제목을 안 정한 노트의 rel — 편집기가 제목칸을 열어 준다 */
  pendingTitleRel: string | null;
  clearPendingTitle(): void;
  openToday(): Promise<void>;
  /** 특정 날짜의 일지 열기 (없으면 만든다 — 달력에서 고를 때 쓴다) */
  openDailyDate(date: string): Promise<void>;
  deleteCurrent(): Promise<void>;
  appendEntry(kind: EntryKind, text: string): Promise<void>;
  /** 데일리노트 빠른 입력 (할 일/기록/느낌) */
  appendDaily(kind: DailyKind, text: string): Promise<void>;
  /** 사용자 정의 종류로 기록 추가 (임의 이름 콜아웃) */
  appendCalloutKind(label: string, text: string): Promise<void>;
  openReadingForBook(bookRelPath: string): Promise<void>;
  openByTitle(title: string): Promise<void>;
  addCustomType(
    label: string,
    id: string,
    fields: FieldDef[],
    template: string,
  ): Promise<boolean>;
  renameCurrent(newTitle: string): Promise<void>;
  /** 현재 열려 있는 노트를 다른 분류로 옮긴다 (파일 이동 + type 갱신) */
  moveCurrent(newTypeId: string): Promise<void>;
  addMirror(): Promise<void>;
  removeMirror(path: string): Promise<void>;
  syncMirrors(): Promise<void>;
  /** 밀려 있는 목록 파일 재생성과 미러 복제를 지금 끝낸다 (창 닫기 직전).
   *  밀린 게 없으면 아무 일도 안 한다 */
  flushMirrors(): Promise<void>;
  resolveMirrorConflict(target: string, rel: string, pull: boolean): Promise<void>;
  reloadCurrent(): Promise<void>;
  dismissExternalChange(): void;
  updateFrontmatter(relPath: string, patch: FmObject): Promise<void>;
  /** 전체 재색인 후 색인된 노트 수 반환 (실패 시 undefined) */
  reindexAll(): Promise<number | undefined>;
  /** 렌더 밖에서 터진 오류를 화면 알림으로 올린다 */
  setError(message: string): void;
  clearError(): void;
}

// React StrictMode의 effect 이중 실행으로 init이 중복 호출되는 것을 방지
let initStarted = false;
// 진행 중인 저장 (없으면 null). 겹친 요청은 이 약속을 함께 기다린다.
let saving: Promise<void> | null = null;
// 저장이 도는 사이에 또 저장 요청이 들어왔다 — 끝나면 한 번 더 돈다.
// 예전에는 그냥 무시했는데, 그러면 저장 중에 누른 Ctrl+S가 아무 일도 하지 않았다.
let resaveRequested = false;
// 미러 동기화 디바운스 타이머
let mirrorTimer: ReturnType<typeof setTimeout> | null = null;
/** 마지막 변경 뒤 이만큼 잠잠하면 미러로 복제한다 */
const MIRROR_IDLE_MS = 60_000;
// `_index.md` 재생성 디바운스 타이머
let indexTimer: ReturnType<typeof setTimeout> | null = null;
/** 마지막 변경 뒤 이만큼 잠잠하면 목록 파일을 다시 만든다 */
const INDEX_IDLE_MS = 5_000;

export const useVault = create<VaultStore>((set, get) => {
  async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }

  /** 손을 멈추면 타입별 `_index.md`를 다시 만든다.
   *
   *  이 파일은 다른 편집기(옵시디언 등)에서 훑어보라고 만들어 두는 자동 생성 목록이다.
   *  만드는 데 그 폴더를 전부 읽어야 해서, 저장할 때마다 하면 타이핑하는 내내 앱이 멈춘다.
   *  몇 초 늦게 반영돼도 아무 문제가 없는 파일이라 한가할 때 몰아서 만든다. */
  function scheduleIndexFiles() {
    if (indexTimer) clearTimeout(indexTimer);
    indexTimer = setTimeout(() => {
      indexTimer = null;
      commands.flushIndexFiles().catch(() => {});
    }, INDEX_IDLE_MS);
  }

  /** 실제 저장 한 바퀴. 도는 사이에 저장 요청이 또 들어왔으면 최신 내용으로 한 번 더 돈다. */
  async function runSave(): Promise<void> {
    do {
      resaveRequested = false;
      const cur = get().current;
      if (!cur) return;
      await guard(async () => {
        unwrap(
          await commands.saveNote(cur.rel_path, cur.frontmatter, cur.body),
        );
        // 저장이 도는 동안 더 친 글자가 있으면 dirty를 유지한다.
        // 무조건 false로 두면 그 글자들은 "저장됨" 표시 뒤에 메모리에만 남고,
        // 자동저장 타이머도 !dirty로 멈춰 화면을 옮기는 순간 사라진다.
        const now = get().current;
        const nothingNewer =
          now?.rel_path === cur.rel_path &&
          now.body === cur.body &&
          now.frontmatter === cur.frontmatter;
        if (nothingNewer) set({ dirty: false });
        await get().refresh();
        // 같은 노트를 띄운 다른 창이 따라오도록 알린다
        await notifyOtherWindows([cur.rel_path]);
        afterWrite();
      });
    } while (resaveRequested);
  }

  /** 손을 멈춘 지 한참 지나면 미러로 복제 (변경이 잦으면 마지막 것만).
   *
   *  예전엔 2초였다. 자동저장이 3초마다 도니까 타이머가 저장 사이사이에 끼어들어,
   *  타이핑하는 내내 몇 초에 한 번씩 vault 전체를 훑었다. 미러는 백업이지 실시간
   *  동기화가 아니므로 한참 쉬었을 때만 돌면 된다. 창을 닫을 때도 따로 한 번 돈다. */
  function afterWrite() {
    scheduleIndexFiles();
    if (get().mirrors.length === 0) return;
    if (mirrorTimer) clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(() => {
      mirrorTimer = null;
      get().syncMirrors();
    }, MIRROR_IDLE_MS);
  }

  /** 제목을 정하지 않고 떠나는 노트에 `{날짜} {본문 첫머리}`로 이름을 붙인다.
   *  실패해도 화면 전환을 막지 않는다(이름이 없을 뿐 내용은 이미 저장돼 있다). */
  async function autoTitleLeaving() {
    const rel = get().pendingTitleRel;
    if (!rel) return;
    set({ pendingTitleRel: null });
    try {
      await commands.autoTitleNote(rel);
      await get().refresh();
    } catch {
      // 무시
    }
  }

  /** vault 경로를 열고 설정에 저장한 뒤 목록·스키마를 새로고침한다 */
  async function activateVault(vaultPath: string) {
    unwrap(await commands.setVault(vaultPath));
    const store = await settings();
    await store.set("vaultPath", vaultPath);
    set({ vaultPath, current: null, dirty: false });
    await commands.setHistoryPolicy(get().historyMax, get().historyIntervalSecs);
    await get().refreshSchemas();
    await get().refresh();
    await get().refreshCallouts();
    // vault를 바꾸면 색인이 새로 만들어진다 — 첨부 검색이 켜져 있으면 다시 채운다
    if (get().searchInFiles) {
      commands.buildFileIndex().catch(() => {});
    }
  }

  return {
    nav: "home",
    async setNav(t) {
      if (get().dirty) await get().saveCurrent();
      await autoTitleLeaving();
      set({ nav: t, current: null, dirty: false });
      const store = await settings();
      await store.set("lastNav", t);
      await store.delete("lastNoteRel");
      // 일지는 "오늘 것을 쓰는 곳"이 기본이다 — 목록 대신 오늘 노트를 연다.
      // 지난 날짜는 노트 헤더의 날짜 이동기나 옆의 [지난 일지] 목록으로 간다.
      if (t === "daily") await get().openToday();
    },
    vaultPath: null,
    schemas: [],
    notes: [],
    current: null,
    dirty: false,
    error: null,
    initialized: false,
    layout: "three",
    deleteConfirm: true,
    async setDeleteConfirm(v) {
      set({ deleteConfirm: v });
      const store = await settings();
      await store.set("deleteConfirm", v);
    },
    bookPickerView: "grid",
    async setBookPickerView(v) {
      set({ bookPickerView: v });
      const store = await settings();
      await store.set("bookPickerView", v);
    },
    callouts: [],
    async refreshCallouts() {
      const r = await commands.listCallouts();
      if (r.status === "ok") set({ callouts: r.data });
    },
    todoBig: false,
    async toggleTodoBig() {
      const v = !get().todoBig;
      set({ todoBig: v });
      const store = await settings();
      await store.set("todoBig", v);
    },
    quickCaptureOn: false,
    quickCaptureShortcut: DEFAULT_CAPTURE_SHORTCUT,
    captureError: null,
    async setQuickCaptureOn(v) {
      set({ quickCaptureOn: v, captureError: null });
      const store = await settings();
      await store.set("quickCaptureOn", v);
      if (v) {
        const err = await enableCapture(get().quickCaptureShortcut);
        if (err) set({ captureError: err });
      } else {
        await disableCapture();
      }
    },
    async setQuickCaptureShortcut(sc) {
      set({ quickCaptureShortcut: sc, captureError: null });
      const store = await settings();
      await store.set("quickCaptureShortcut", sc);
      if (get().quickCaptureOn) {
        const err = await enableCapture(sc);
        if (err) set({ captureError: err });
      }
    },
    reviewShowReading: false,
    async toggleReviewShowReading() {
      const v = !get().reviewShowReading;
      set({ reviewShowReading: v });
      const store = await settings();
      await store.set("reviewShowReading", v);
    },
    searchFuzzy: false,
    async toggleSearchFuzzy() {
      const v = !get().searchFuzzy;
      set({ searchFuzzy: v });
      const store = await settings();
      await store.set("searchFuzzy", v);
    },
    searchInFiles: false,
    async toggleSearchInFiles() {
      const v = !get().searchInFiles;
      set({ searchInFiles: v });
      const store = await settings();
      await store.set("searchInFiles", v);
      // 켜면 백그라운드에서 추출·색인, 끄면 색인에서 즉시 뺀다.
      // (추출 캐시는 남으므로 다시 켤 때는 재추출 없이 채워진다)
      if (v) await commands.buildFileIndex();
      else await commands.dropFileIndex();
    },
    todoPanel: "bottom",
    async setTodoPanel(v) {
      set({ todoPanel: v });
      const store = await settings();
      await store.set("todoPanel", v);
    },
    dailyKindOrder: DEFAULT_DAILY_KIND_ORDER,
    async setDailyKindOrder(order) {
      set({ dailyKindOrder: order });
      const store = await settings();
      await store.set("dailyKindOrder", order);
    },
    createTick: 0,
    requestCreate() {
      set({ current: null, createTick: get().createTick + 1 });
    },
    theme: "light",
    async setTheme(mode) {
      set({ theme: mode });
      applyTheme(mode);
      const store = await settings();
      await store.set("theme", mode);
    },
    startupMode: "last",
    async setStartupMode(mode) {
      set({ startupMode: mode });
      const store = await settings();
      await store.set("startupMode", mode);
    },
    startupTabId: null,
    async setStartupTabId(id) {
      set({ startupTabId: id });
      const store = await settings();
      await store.set("startupTabId", id);
    },
    startupNoteRel: null,
    async setStartupNoteRel(rel) {
      set({ startupNoteRel: rel });
      const store = await settings();
      await store.set("startupNoteRel", rel);
    },
    startupNotice: null,
    dismissStartupNotice() {
      set({ startupNotice: null });
    },
    shortcutsOff: [],
    async toggleShortcut(id) {
      const off = get().shortcutsOff;
      const next = off.includes(id)
        ? off.filter((x) => x !== id)
        : [...off, id];
      set({ shortcutsOff: next });
      const store = await settings();
      await store.set("shortcutsOff", next);
    },
    trashRetentionDays: 7,
    async setTrashRetention(days) {
      set({ trashRetentionDays: days });
      const store = await settings();
      await store.set("trashRetentionDays", days);
    },
    mirrors: [],
    mirrorReports: [],
    externalChanged: false,
    issues: [],
    historyMax: 20,
    historyIntervalSecs: 300,

    async refreshIssues() {
      // 배지용 조회 — 실패해도 앱 흐름을 막지 않는다
      const r = await commands.auditVault();
      if (r.status === "ok") set({ issues: r.data });
    },

    async fixIssue(relPath, kind) {
      const ok = await guard(async () => {
        unwrap(await commands.fixIssue(relPath, kind));
        await get().refresh();
        return true;
      });
      return ok === true;
    },

    async setHistoryPolicy(max, intervalSecs) {
      set({ historyMax: max, historyIntervalSecs: intervalSecs });
      const store = await settings();
      await store.set("historyMax", max);
      await store.set("historyIntervalSecs", intervalSecs);
      await commands.setHistoryPolicy(max, intervalSecs);
    },

    async init() {
      if (initStarted) return;
      initStarted = true;
      await guard(async () => {
        const store = await settings();
        const layout = ((await store.get<string>("layout")) ??
          "three") as LayoutMode;
        const mirrors = (await store.get<string[]>("mirrorPaths")) ?? [];
        const deleteConfirm =
          (await store.get<boolean>("deleteConfirm")) ?? true;
        const bookPickerView =
          (await store.get<"grid" | "list">("bookPickerView")) ?? "grid";
        const trashRetentionDays =
          (await store.get<number>("trashRetentionDays")) ?? 7;
        const historyMax = (await store.get<number>("historyMax")) ?? 20;
        const historyIntervalSecs =
          (await store.get<number>("historyIntervalSecs")) ?? 300;
        const todoPanel =
          (await store.get<"bottom" | "right">("todoPanel")) ?? "bottom";
        const todoBig = (await store.get<boolean>("todoBig")) ?? false;
        const quickCaptureOn =
          (await store.get<boolean>("quickCaptureOn")) ?? false;
        const quickCaptureShortcut =
          (await store.get<string>("quickCaptureShortcut")) ??
          DEFAULT_CAPTURE_SHORTCUT;
        const reviewShowReading =
          (await store.get<boolean>("reviewShowReading")) ?? false;
        const searchFuzzy = (await store.get<boolean>("searchFuzzy")) ?? false;
        const searchInFiles = (await store.get<boolean>("searchInFiles")) ?? false;
        const dailyKindOrder =
          (await store.get<string[]>("dailyKindOrder")) ??
          DEFAULT_DAILY_KIND_ORDER;
        const shortcutsOff = (await store.get<string[]>("shortcutsOff")) ?? [];
        const theme = (await store.get<ThemeMode>("theme")) ?? "light";
        applyTheme(theme);
        const startupMode =
          (await store.get<StartupMode>("startupMode")) ?? "last";
        const startupTabId =
          (await store.get<string>("startupTabId")) ?? null;
        const startupNoteRel =
          (await store.get<string>("startupNoteRel")) ?? null;
        set({
          theme,
          startupMode,
          startupTabId,
          startupNoteRel,
          shortcutsOff,
          deleteConfirm,
          bookPickerView,
          trashRetentionDays,
          historyMax,
          historyIntervalSecs,
          todoPanel,
          todoBig,
          quickCaptureOn,
          quickCaptureShortcut,
          reviewShowReading,
          searchFuzzy,
          searchInFiles,
          dailyKindOrder,
        });
        // 켜 둔 채로 앱을 껐었다면 다시 걸어 준다. 실패해도 시작을 막지 않는다.
        if (quickCaptureOn) {
          const err = await enableCapture(quickCaptureShortcut);
          if (err) set({ captureError: err });
        }
        const saved = (await store.get<string>("vaultPath")) ?? null;
        if (saved) {
          unwrap(await commands.setVault(saved));
          set({ vaultPath: saved, layout, mirrors });
          // vault를 연 뒤에 스냅샷 정책 적용 (실패는 무시 — 기본값으로 동작)
          await commands.setHistoryPolicy(historyMax, historyIntervalSecs);
          await get().refreshSchemas();
          await get().refresh();
          await get().refreshCallouts();
          // 오래된 휴지통 항목 자동 정리 (실패는 무시)
          if (trashRetentionDays > 0) {
            commands.purgeTrash(trashRetentionDays).catch(() => {});
          }
          // set_vault가 검색 색인을 비우고 노트만 다시 채우므로, 첨부 검색이 켜져 있으면
          // 여기서 다시 채워야 한다. 추출 캐시가 있어 재추출은 없다(실측 105개 1.3초).
          if (searchInFiles) {
            commands.buildFileIndex().catch(() => {});
          }
          // 시작 화면 적용 (실패는 조용히 무시, 기본 home).
          // 지정한 탭/글이 사라졌으면(분류 삭제·노트 삭제·제목변경 등) 홈을 열고 이유를 안내한다.
          try {
            if (startupMode === "last") {
              const lastNav = await store.get<string>("lastNav");
              if (lastNav) set({ nav: lastNav });
              const lastNoteRel = await store.get<string>("lastNoteRel");
              if (
                lastNoteRel &&
                get().notes.some((n) => n.rel_path === lastNoteRel)
              ) {
                await get().openNote(lastNoteRel);
              }
            } else if (startupMode === "tab") {
              const validIds = new Set([
                "home",
                "reading",
                "tags",
                ...get().schemas.map((s) => s.id),
              ]);
              if (startupTabId && validIds.has(startupTabId)) {
                set({ nav: startupTabId });
              } else {
                set({ startupNotice: "지정한 시작 탭이 없어 홈을 열었습니다" });
              }
            } else if (startupMode === "note") {
              const found =
                !!startupNoteRel &&
                get().notes.some((n) => n.rel_path === startupNoteRel);
              if (found) {
                await get().openNote(startupNoteRel as string);
              } else {
                set({ startupNotice: "지정한 글을 찾을 수 없어 홈을 열었습니다" });
              }
            }
            // startupMode === "home"이면 기본값(nav="home")을 그대로 둔다
          } catch {
            // 무시
          }
          // 시작 시 전체 미러 동기화
          if (mirrors.length > 0) get().syncMirrors();
        } else {
          const schemas = await commands.getSchemas();
          set({ schemas, layout, mirrors });
        }
      });
      set({ initialized: true });

      // 외부 파일 변경 이벤트 (파일 감시)
      await listen<string[]>("vault-external-change", async (e) => {
        const changed = e.payload;
        await get().refresh();
        const cur = get().current;
        if (cur && changed.includes(cur.rel_path)) {
          if (get().dirty) {
            set({ externalChanged: true });
          } else {
            await get().reloadCurrent();
          }
        }
      });
    },

    async chooseVault() {
      await guard(async () => {
        const dir = await openDialog({
          directory: true,
          title: "메모를 저장할 위치 선택 (하위에 YamchaMemo 폴더가 만들어집니다)",
        });
        if (typeof dir !== "string") return;
        // 선택 폴더 아래 YamchaMemo를 vault로 사용 (이미 그 이름이면 그대로)
        const base = dir.replace(/[\\/]+$/, "");
        const name = base.split(/[\\/]/).pop();
        const vaultPath =
          name === "YamchaMemo" ? base : await join(base, "YamchaMemo");
        await activateVault(vaultPath);
      });
    },

    async startAt(base) {
      await guard(async () => {
        const trimmed = base.replace(/[\\/]+$/, "");
        const name = trimmed.split(/[\\/]/).pop();
        const vaultPath =
          name === "YamchaMemo" ? trimmed : await join(trimmed, "YamchaMemo");
        await activateVault(vaultPath);
      });
    },

    async refresh() {
      await guard(async () => {
        const notes = unwrap(await commands.listNotes());
        set({ notes });
      });
      // 목록에서 조용히 빠진 파일이 있는지 함께 확인 (실패는 무시)
      await get().refreshIssues();
    },

    async refreshSchemas() {
      await guard(async () => {
        const schemas = await commands.getSchemas();
        set({ schemas });
      });
    },

    async setLayout(mode) {
      set({ layout: mode });
      const store = await settings();
      await store.set("layout", mode);
    },

    async openNote(relPath) {
      const { dirty } = get();
      if (dirty) await get().saveCurrent();
      // 다른 노트로 넘어가는 경우에만 자동 명명 (자기 자신을 다시 여는 건 제외)
      if (get().pendingTitleRel && get().pendingTitleRel !== relPath) {
        await autoTitleLeaving();
      }
      await guard(async () => {
        const note = unwrap(await commands.readNote(relPath));
        set({ current: note, dirty: false, nav: note.note_type });
        const store = await settings();
        await store.set("lastNav", note.note_type);
        await store.set("lastNoteRel", relPath);
      });
    },

    closeNote() {
      autoTitleLeaving();
      set({ current: null, dirty: false });
      settings().then((s) => s.delete("lastNoteRel"));
    },

    setBody(body) {
      const cur = get().current;
      if (!cur) return;
      set({ current: { ...cur, body }, dirty: true });
    },

    setFrontmatter(fm) {
      const cur = get().current;
      if (!cur) return;
      set({ current: { ...cur, frontmatter: fm }, dirty: true });
    },

    async saveCurrent() {
      // 이미 저장이 돌고 있으면 끝난 뒤 한 번 더 돌도록 예약하고, 그 저장까지 기다린다.
      // (여기서 그냥 return하면 저장 중에 누른 Ctrl+S가 조용히 사라진다)
      if (saving) {
        resaveRequested = true;
        await saving;
        return;
      }
      saving = runSave().finally(() => {
        saving = null;
      });
      await saving;
    },

    async createNote(t, title, fields) {
      await guard(async () => {
        const rel = unwrap(await commands.createNote(t, title, fields));
        await get().refresh();
        await get().openNote(rel);
        afterWrite();
      });
    },

    pendingTitleRel: null,
    clearPendingTitle() {
      set({ pendingTitleRel: null });
    },

    async createUntitled(t) {
      await guard(async () => {
        const rel = unwrap(await commands.createNote(t, "", {}));
        await get().refresh();
        await get().openNote(rel);
        set({ pendingTitleRel: rel });
        afterWrite();
      });
    },

    async openDailyDate(date) {
      await guard(async () => {
        if (get().dirty) await get().saveCurrent();
        const rel = unwrap(await commands.openDaily(date));
        await get().refresh();
        await get().openNote(rel);
      });
    },
    async openToday() {
      await guard(async () => {
        const rel = unwrap(await commands.openTodayDaily());
        await get().refresh();
        await get().openNote(rel);
      });
    },

    async deleteCurrent() {
      const cur = get().current;
      if (!cur) return;
      await guard(async () => {
        unwrap(await commands.deleteNote(cur.rel_path));
        set({ current: null, dirty: false });
        await get().refresh();
        afterWrite();
      });
    },

    async appendEntry(kind, text) {
      const cur = get().current;
      if (!cur) return;
      if (get().dirty) await get().saveCurrent();
      await guard(async () => {
        const updated = unwrap(
          await commands.appendReadingEntry(cur.rel_path, kind, text),
        );
        set({ current: updated, dirty: false });
        await notifyOtherWindows([cur.rel_path]);
        afterWrite();
      });
    },

    async appendDaily(kind, text) {
      const cur = get().current;
      if (!cur) return;
      if (get().dirty) await get().saveCurrent();
      await guard(async () => {
        const updated = unwrap(
          await commands.appendDailyEntry(cur.rel_path, kind, text),
        );
        set({ current: updated, dirty: false });
        await get().refresh();
        await notifyOtherWindows([cur.rel_path]);
        afterWrite();
      });
    },

    async appendCalloutKind(label, text) {
      const cur = get().current;
      if (!cur) return;
      if (get().dirty) await get().saveCurrent();
      await guard(async () => {
        const updated = unwrap(
          await commands.appendCallout(cur.rel_path, label, text),
        );
        set({ current: updated, dirty: false });
        await get().refresh();
        await notifyOtherWindows([cur.rel_path]);
        afterWrite();
      });
    },

    async openReadingForBook(bookRelPath) {
      await guard(async () => {
        const rel = unwrap(await commands.readingForBook(bookRelPath));
        await get().refresh();
        await get().openNote(rel);
      });
    },

    /** 위키링크 타깃(제목 또는 파일명 stem)으로 노트 열기 */
    async openByTitle(title) {
      const t = title.trim();
      const notes = get().notes;
      const found =
        notes.find((n) => n.title === t) ??
        notes.find((n) => {
          const stem = n.rel_path.split("/").pop()?.replace(/\.md$/, "");
          return stem === t;
        });
      if (found) {
        await get().openNote(found.rel_path);
      } else {
        set({ error: `노트를 찾을 수 없습니다: ${t}` });
      }
    },

    async addCustomType(label, id, fields, template) {
      const ok = await guard(async () => {
        unwrap(await commands.addCustomType(label, id, fields, template));
        await get().refreshSchemas();
        return true;
      });
      return ok === true;
    },

    async renameCurrent(newTitle) {
      const cur = get().current;
      if (!cur) return;
      if (get().dirty) await get().saveCurrent();
      await guard(async () => {
        const newRel = unwrap(await commands.renameNote(cur.rel_path, newTitle));
        await get().refresh();
        await get().openNote(newRel);
      });
    },

    async moveCurrent(newTypeId) {
      const cur = get().current;
      if (!cur) return;
      if (get().dirty) await get().saveCurrent();
      await guard(async () => {
        const newRel = unwrap(await commands.moveNote(cur.rel_path, newTypeId));
        await get().refresh();
        await get().openNote(newRel);
      });
    },

    async updateFrontmatter(relPath, patch) {
      await guard(async () => {
        unwrap(await commands.updateFrontmatter(relPath, patch));
        await get().refresh();
        afterWrite();
      });
    },

    async addMirror() {
      await guard(async () => {
        const dir = await openDialog({
          directory: true,
          title: "미러(백업) 폴더 선택 — 클라우드 동기화 폴더 추천",
        });
        if (typeof dir !== "string") return;
        const mirrors = [...new Set([...get().mirrors, dir])];
        set({ mirrors });
        const store = await settings();
        await store.set("mirrorPaths", mirrors);
        await get().syncMirrors();
      });
    },

    async removeMirror(path) {
      const mirrors = get().mirrors.filter((m) => m !== path);
      set({ mirrors, mirrorReports: get().mirrorReports.filter((r) => r.target !== path) });
      const store = await settings();
      await store.set("mirrorPaths", mirrors);
    },

    async syncMirrors() {
      const mirrors = get().mirrors;
      if (mirrors.length === 0) return;
      await guard(async () => {
        const reports = unwrap(await commands.mirrorSync(mirrors));
        set({ mirrorReports: reports });
      });
    },

    async flushMirrors() {
      // 목록 파일이 밀려 있으면 먼저 만든다 — 미러가 그걸 실어 가야 한다
      if (indexTimer) {
        clearTimeout(indexTimer);
        indexTimer = null;
        await commands.flushIndexFiles().catch(() => {});
      }
      if (!mirrorTimer) return; // 마지막 복제 뒤로 바뀐 게 없다
      clearTimeout(mirrorTimer);
      mirrorTimer = null;
      await get().syncMirrors();
    },

    async resolveMirrorConflict(target, rel, pull) {
      await guard(async () => {
        unwrap(await commands.mirrorResolve(target, rel, pull));
        await get().refresh();
        await get().syncMirrors();
        if (pull && get().current?.rel_path === rel) {
          await get().reloadCurrent();
        }
      });
    },

    async reloadCurrent() {
      const cur = get().current;
      if (!cur) return;
      await guard(async () => {
        const note = unwrap(await commands.readNote(cur.rel_path));
        set({ current: note, dirty: false, externalChanged: false });
      });
    },

    dismissExternalChange() {
      set({ externalChanged: false });
    },

    async reindexAll() {
      return await guard(async () => {
        return unwrap(await commands.reindex());
      });
    },

    setError(message) {
      set({ error: message });
    },
    clearError() {
      set({ error: null });
    },
  };
});

/** 현재 노트의 frontmatter를 객체로 안전하게 꺼낸다 */
export function fmObject(note: NoteContent | null): FmObject {
  if (!note) return {};
  const fm = note.frontmatter;
  if (fm && typeof fm === "object" && !Array.isArray(fm)) return fm;
  return {};
}

/** 타입 id → 라벨 (schemas 기반, 없으면 id 그대로) */
export function typeLabel(schemas: TypeDef[], id: string): string {
  return schemas.find((s) => s.id === id)?.label ?? id;
}
