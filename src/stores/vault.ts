import { create } from "zustand";
import { load } from "@tauri-apps/plugin-store";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import {
  commands,
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
  openToday(): Promise<void>;
  deleteCurrent(): Promise<void>;
  appendEntry(kind: EntryKind, text: string): Promise<void>;
  openReadingForBook(bookRelPath: string): Promise<void>;
  openByTitle(title: string): Promise<void>;
  addCustomType(
    label: string,
    fields: FieldDef[],
    template: string,
  ): Promise<boolean>;
  renameCurrent(newTitle: string): Promise<void>;
  addMirror(): Promise<void>;
  removeMirror(path: string): Promise<void>;
  syncMirrors(): Promise<void>;
  resolveMirrorConflict(target: string, rel: string, pull: boolean): Promise<void>;
  reloadCurrent(): Promise<void>;
  dismissExternalChange(): void;
  updateFrontmatter(relPath: string, patch: FmObject): Promise<void>;
  /** 전체 재색인 후 색인된 노트 수 반환 (실패 시 undefined) */
  reindexAll(): Promise<number | undefined>;
  clearError(): void;
}

// React StrictMode의 effect 이중 실행으로 init이 중복 호출되는 것을 방지
let initStarted = false;
// saveCurrent 재진입 가드 (Ctrl+S 연타·자동저장 중복 방지)
let saving = false;
// 미러 동기화 디바운스 타이머
let mirrorTimer: ReturnType<typeof setTimeout> | null = null;

export const useVault = create<VaultStore>((set, get) => {
  async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }

  /** 변경 2초 뒤 미러로 복제 (변경이 잦으면 마지막 것만) */
  function scheduleMirror() {
    if (get().mirrors.length === 0) return;
    if (mirrorTimer) clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(() => get().syncMirrors(), 2000);
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
  }

  return {
    nav: "home",
    async setNav(t) {
      if (get().dirty) await get().saveCurrent();
      set({ nav: t, current: null, dirty: false });
      const store = await settings();
      await store.set("lastNav", t);
      await store.delete("lastNoteRel");
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
        set({
          deleteConfirm,
          bookPickerView,
          trashRetentionDays,
          historyMax,
          historyIntervalSecs,
        });
        const saved = (await store.get<string>("vaultPath")) ?? null;
        if (saved) {
          unwrap(await commands.setVault(saved));
          set({ vaultPath: saved, layout, mirrors });
          // vault를 연 뒤에 스냅샷 정책 적용 (실패는 무시 — 기본값으로 동작)
          await commands.setHistoryPolicy(historyMax, historyIntervalSecs);
          await get().refreshSchemas();
          await get().refresh();
          // 오래된 휴지통 항목 자동 정리 (실패는 무시)
          if (trashRetentionDays > 0) {
            commands.purgeTrash(trashRetentionDays).catch(() => {});
          }
          // 마지막 메뉴·노트 복원 (실패는 조용히 무시, 기본 home)
          try {
            const lastNav = await store.get<string>("lastNav");
            if (lastNav) set({ nav: lastNav });
            const lastNoteRel = await store.get<string>("lastNoteRel");
            if (
              lastNoteRel &&
              get().notes.some((n) => n.rel_path === lastNoteRel)
            ) {
              await get().openNote(lastNoteRel);
            }
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
      await guard(async () => {
        const note = unwrap(await commands.readNote(relPath));
        set({ current: note, dirty: false, nav: note.note_type });
        const store = await settings();
        await store.set("lastNav", note.note_type);
        await store.set("lastNoteRel", relPath);
      });
    },

    closeNote() {
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
      const cur = get().current;
      if (!cur) return;
      if (saving) return;
      saving = true;
      try {
        await guard(async () => {
          unwrap(
            await commands.saveNote(cur.rel_path, cur.frontmatter, cur.body),
          );
          set({ dirty: false });
          await get().refresh();
          scheduleMirror();
        });
      } finally {
        saving = false;
      }
    },

    async createNote(t, title, fields) {
      await guard(async () => {
        const rel = unwrap(await commands.createNote(t, title, fields));
        await get().refresh();
        await get().openNote(rel);
        scheduleMirror();
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
        scheduleMirror();
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
        scheduleMirror();
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

    async addCustomType(label, fields, template) {
      const ok = await guard(async () => {
        unwrap(await commands.addCustomType(label, fields, template));
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

    async updateFrontmatter(relPath, patch) {
      await guard(async () => {
        unwrap(await commands.updateFrontmatter(relPath, patch));
        await get().refresh();
        scheduleMirror();
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
