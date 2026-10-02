import { beforeEach, describe, expect, it, vi } from "vitest";

/** 저장이 막혔을 때(충돌·실패) 다른 일로 넘어가며 친 글자를 잃던 버그를 붙잡는다.
 *  예전엔 저장을 한 번 부르고 결과와 상관없이 다음 노트로 갈아 끼우거나, 디스크에 덧붙인
 *  결과로 화면을 덮거나, 창을 닫았다. */

/** 다음 저장이 어떻게 끝날지 */
let saveOutcome: "ok" | "conflict" | "error" = "ok";
const saveCalls: string[] = [];
const called: string[] = [];
let copyFails = false;
/** 노트 읽기를 붙잡아 둔다 — 읽는 사이에 사용자가 치는 상황을 만든다 */
let holdRead: Promise<void> | null = null;
let readStarted: (() => void) | null = null;
const copyCalls: { rel: string; body: string }[] = [];

vi.mock("../bindings", () => ({
  commands: {
    saveNote: async (_rel: string, _fm: unknown, body: string) => {
      saveCalls.push(body);
      if (saveOutcome === "error") return { status: "error", error: "디스크 공간이 부족합니다" };
      return {
        status: "ok",
        data: { stamp: "새-지문", conflict: saveOutcome === "conflict" },
      };
    },
    readNote: async (rel: string) => {
      readStarted?.();
      if (holdRead) await holdRead;
      return {
      status: "ok",
      data: {
        rel_path: rel,
        note_type: rel.startsWith("Daily/") ? "daily" : "free",
        frontmatter: {},
        body: `디스크의 ${rel}`,
        stamp: "디스크-지문",
      },
      };
    },
    appendDailyEntry: async (rel: string) => {
      called.push("appendDailyEntry");
      return {
        status: "ok",
        data: { rel_path: rel, note_type: "daily", frontmatter: {}, body: "디스크 + 덧붙임", stamp: "x" },
      };
    },
    appendReadingEntry: async () => {
      called.push("appendReadingEntry");
      return { status: "error", error: "부르면 안 된다" };
    },
    appendCallout: async () => {
      called.push("appendCallout");
      return { status: "error", error: "부르면 안 된다" };
    },
    toggleTodo: async () => {
      called.push("toggleTodo");
      return { status: "error", error: "부르면 안 된다" };
    },
    openTodayDaily: async () => ({ status: "ok", data: "Daily/2026/10/2026-10-02.md" }),
    openDaily: async () => ({ status: "ok", data: "Daily/2026/10/2026-10-01.md" }),
    createNote: async () => {
      called.push("createNote");
      return { status: "ok", data: "Free/새 노트.md" };
    },
    saveConflictCopy: async (rel: string, _fm: unknown, body: string) => {
      copyCalls.push({ rel, body });
      if (copyFails) return { status: "error", error: "쓸 수 없음" };
      return { status: "ok", data: "Free/메모 (저장 못 한 편집 2026-10-02 1530).md" };
    },
    listNotes: async () => ({ status: "ok", data: [] }),
    listTodos: async () => ({ status: "ok", data: { items: [], open_total: 0, done_total: 0, truncated: false } }),
    noteSummary: async () => ({ status: "error", error: "없음" }),
    auditVault: async () => ({ status: "ok", data: [] }),
    flushIndexFiles: async () => ({ status: "ok", data: null }),
    autoTitleNote: async () => ({ status: "ok", data: "" }),
  },
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ get: async () => null, set: async () => {}, delete: async () => {} }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/path", () => ({ join: async (...p: string[]) => p.join("/") }));
vi.mock("../lib/windowSync", () => ({ notifyOtherWindows: async () => {} }));
vi.mock("../lib/quickCapture", () => ({
  DEFAULT_CAPTURE_SHORTCUT: "",
  disableCapture: async () => {},
  enableCapture: async () => {},
}));

const { useVault } = await import("./vault");

const REL = "Daily/2026/10/2026-10-02.md";

/** 일지 한 편을 열고 글자를 친 상태 — 다음 저장은 `outcome`으로 끝난다 */
function typed(outcome: typeof saveOutcome) {
  useVault.setState({
    nav: "daily",
    current: {
      rel_path: REL,
      note_type: "daily",
      frontmatter: {},
      body: "처음",
      stamp: "읽어온-지문",
    } as never,
    dirty: false,
    notes: [],
    externalChanged: false,
    forceOverwrite: false,
    saveFailed: null,
    error: null,
  });
  useVault.getState().setBody("내가 친 글자");
  saveOutcome = outcome;
}

function expectKept() {
  const s = useVault.getState();
  expect(s.current?.rel_path).toBe(REL);
  expect(s.current?.body).toBe("내가 친 글자");
  expect(s.dirty).toBe(true);
}

beforeEach(() => {
  saveCalls.length = 0;
  called.length = 0;
  copyCalls.length = 0;
  copyFails = false;
});

describe("저장이 막히면 다른 일로 넘어가지 않는다", () => {
  for (const outcome of ["conflict", "error"] as const) {
    describe(outcome === "conflict" ? "밖에서 바뀜(충돌)" : "쓰기 실패", () => {
      it("다른 노트를 열지 않는다", async () => {
        typed(outcome);
        await useVault.getState().openNote("Free/다른 노트.md");
        expectKept();
        expect(useVault.getState().error).toBeTruthy();
      });

      it("메뉴를 옮기지 않는다", async () => {
        typed(outcome);
        await useVault.getState().setNav("free");
        expectKept();
        expect(useVault.getState().nav).toBe("daily");
      });

      it("목록으로 돌아가지 않는다", async () => {
        typed(outcome);
        await useVault.getState().closeNote();
        expectKept();
      });

      it("일지에 덧붙이지 않는다 (덧붙인 결과가 화면을 덮는다)", async () => {
        typed(outcome);
        await useVault.getState().appendDaily("log", "새 줄");
        await useVault.getState().appendCalloutKind("아이디어", "새 줄");
        await useVault.getState().appendEntry("quote" as never, "새 줄");
        expectKept();
        expect(called).toEqual([]);
      });

      it("열린 노트의 할 일을 체크하지 않는다", async () => {
        typed(outcome);
        await useVault.getState().toggleTodoItem({
          rel_path: REL,
          index: 0,
          text: "할 일",
          done: false,
        } as never);
        expectKept();
        expect(called).toEqual([]);
      });

      it("새 노트를 만들지 않는다", async () => {
        typed(outcome);
        await useVault.getState().createNote("free", "새 노트", {});
        expectKept();
        expect(called).toEqual([]);
      });
    });
  }

  it("실패한 까닭을 띠에 남기고, 성공하면 지운다", async () => {
    typed("error");
    await useVault.getState().saveCurrent();
    expect(useVault.getState().saveFailed).toContain("디스크");
    saveOutcome = "ok";
    await useVault.getState().saveCurrent();
    expect(useVault.getState().saveFailed).toBeNull();
    expect(useVault.getState().dirty).toBe(false);
  });

  it("저장되면 그대로 넘어간다", async () => {
    typed("ok");
    await useVault.getState().openNote("Free/다른 노트.md");
    expect(useVault.getState().current?.rel_path).toBe("Free/다른 노트.md");
    expect(saveCalls).toEqual(["내가 친 글자"]);
  });
});

describe("사본으로 저장", () => {
  it("화면의 글을 사본으로 남기고 원래 노트는 디스크 내용으로 다시 읽는다", async () => {
    typed("conflict");
    // 떠나려다 막혔다 — 알림이 뜬다
    await useVault.getState().openNote("Free/다른 노트.md");
    expect(useVault.getState().externalChanged).toBe(true);
    expect(useVault.getState().error).toBeTruthy();

    const copy = await useVault.getState().saveCopyOfCurrent();

    expect(copy).toContain("저장 못 한 편집");
    expect(copyCalls).toEqual([{ rel: REL, body: "내가 친 글자" }]);
    const s = useVault.getState();
    expect(s.dirty).toBe(false);
    expect(s.externalChanged).toBe(false);
    expect(s.current?.body).toBe(`디스크의 ${REL}`);
    // 막힘이 풀렸으니 그 알림도 걷힌다
    expect(s.error).toBeNull();
  });

  it("앱을 닫기 전: 저장되면 사본을 만들지 않는다", async () => {
    typed("ok");
    const r = await useVault.getState().rescueBeforeExit();
    expect(r).toEqual({ ok: true, copy: null });
    expect(copyCalls).toEqual([]);
  });

  it("앱을 닫기 전: 저장이 막히면 사본으로 남긴다", async () => {
    typed("conflict");
    const r = await useVault.getState().rescueBeforeExit();
    expect(r.ok).toBe(true);
    expect(r.copy).toContain("저장 못 한 편집");
    expect(copyCalls[0].body).toBe("내가 친 글자");
  });

  it("앱을 닫기 전: 사본마저 못 쓰면 ok=false (닫을지 사람에게 묻는다)", async () => {
    typed("error");
    copyFails = true;
    const r = await useVault.getState().rescueBeforeExit();
    expect(r.ok).toBe(false);
    expect(useVault.getState().dirty).toBe(true);
  });
});

describe("밖에서 바뀐 노트를 다시 읽는 사이에 친 글자", () => {
  it("덮지 않고 경고로 돌린다", async () => {
    useVault.setState({
      current: { rel_path: REL, note_type: "daily", frontmatter: {}, body: "처음", stamp: "s" } as never,
      dirty: false,
      externalChanged: false,
      error: null,
    });
    let release!: () => void;
    holdRead = new Promise((r) => (release = r));
    const started = new Promise<void>((r) => (readStarted = r));
    const handling = useVault.getState().onExternalChange([REL]);
    await started;
    // 읽기 왕복이 도는 사이에 친다
    useVault.getState().setBody("처음 + 읽는 사이 친 글자");
    release();
    await handling;
    holdRead = null;
    readStarted = null;

    const s = useVault.getState();
    expect(s.current?.body).toBe("처음 + 읽는 사이 친 글자");
    expect(s.dirty).toBe(true);
    expect(s.externalChanged).toBe(true);
  });

  it("손대지 않았으면 다시 읽는다", async () => {
    useVault.setState({
      current: { rel_path: REL, note_type: "daily", frontmatter: {}, body: "처음", stamp: "s" } as never,
      dirty: false,
      externalChanged: false,
    });
    await useVault.getState().onExternalChange([REL]);
    expect(useVault.getState().current?.body).toBe(`디스크의 ${REL}`);
    expect(useVault.getState().dirty).toBe(false);
  });
});
