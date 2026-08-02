import { describe, expect, it, vi, beforeEach } from "vitest";

/** 저장 커맨드를 붙잡아 두는 손잡이 — 저장이 "도는 중"인 상태를 만들어 낸다 */
let releaseSave: (() => void) | null = null;
const saveCalls: { body: string }[] = [];

vi.mock("../bindings", () => ({
  commands: {
    saveNote: (_rel: string, _fm: unknown, body: string) => {
      saveCalls.push({ body });
      return new Promise((resolve) => {
        releaseSave = () => resolve({ status: "ok", data: null });
      });
    },
    listNotes: async () => ({ status: "ok", data: [] }),
    autoTitleNote: async () => ({ status: "ok", data: "" }),
  },
}));

// 저장 경로에서 부수적으로 불리는 것들 — 테스트에서는 아무 일도 하지 않는다
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async () => null,
    set: async () => {},
    delete: async () => {},
  }),
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

/** 노트 하나를 열어 둔 상태로 만든다 (백엔드 없이 스토어만) */
function openNote(body: string) {
  useVault.setState({
    current: {
      rel_path: "Free/메모.md",
      note_type: "free",
      frontmatter: {},
      body,
    } as never,
    dirty: false,
    notes: [],
  });
}

describe("saveCurrent — 저장 중 편집", () => {
  beforeEach(() => {
    releaseSave = null;
    saveCalls.length = 0;
    useVault.setState({ error: null });
  });

  it("저장이 도는 동안 친 글자를 잃지 않는다", async () => {
    openNote("처음 문단");
    useVault.getState().setBody("처음 문단 + 한 줄");
    expect(useVault.getState().dirty).toBe(true);

    // 저장 시작 — 백엔드가 응답하기 전에 멈춰 있다
    const saving = useVault.getState().saveCurrent();
    await vi.waitFor(() => expect(releaseSave).not.toBeNull());

    // 응답을 기다리는 사이에 사용자가 더 친다
    useVault.getState().setBody("처음 문단 + 한 줄 + 저장 중에 친 글자");

    releaseSave!();
    await saving;

    // 방금 친 글자는 아직 디스크에 없다 → 저장할 게 남았다고 표시돼야 한다.
    // 여기서 dirty가 false면 자동저장 타이머가 멈추고, 화면을 옮기는 순간 사라진다.
    expect(useVault.getState().dirty).toBe(true);
    expect(useVault.getState().current?.body).toBe(
      "처음 문단 + 한 줄 + 저장 중에 친 글자",
    );
  });

  it("저장 중에 아무것도 안 쳤으면 깨끗해진다", async () => {
    openNote("그대로 둔다");
    useVault.getState().setBody("한 번만 고친다");

    const saving = useVault.getState().saveCurrent();
    await vi.waitFor(() => expect(releaseSave).not.toBeNull());
    releaseSave!();
    await saving;

    expect(useVault.getState().dirty).toBe(false);
  });

  it("저장 중에 들어온 저장 요청을 버리지 않는다", async () => {
    openNote("처음");
    useVault.getState().setBody("첫 번째 편집");

    const first = useVault.getState().saveCurrent();
    await vi.waitFor(() => expect(releaseSave).not.toBeNull());
    const releaseFirst = releaseSave!;

    // 저장이 도는 중에 Ctrl+S — 예전에는 그냥 무시됐다
    useVault.getState().setBody("두 번째 편집");
    const second = useVault.getState().saveCurrent();

    releaseFirst();
    // 첫 저장이 끝나면 예약해 둔 재저장이 최신 내용으로 한 번 더 돈다
    await vi.waitFor(() => expect(saveCalls.length).toBe(2));
    releaseSave!();
    await Promise.all([first, second]);

    expect(saveCalls[1].body).toBe("두 번째 편집");
    expect(useVault.getState().dirty).toBe(false);
  });
});
