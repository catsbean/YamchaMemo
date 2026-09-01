import { describe, expect, it, vi, beforeEach } from "vitest";

/** 저장 커맨드를 붙잡아 두는 손잡이 — 저장이 "도는 중"인 상태를 만들어 낸다 */
let releaseSave: (() => void) | null = null;
const saveCalls: { rel: string; body: string; expected: string | null }[] = [];
/** 다음 저장이 "그 사이에 파일이 바뀌었다"고 답하게 한다 */
let nextIsConflict = false;
/** 이름 바꾸기 커맨드를 붙잡아 두는 손잡이 — 백엔드 왕복이 "도는 중"인 상태를 만들어 낸다 */
let releaseRename: (() => void) | null = null;
const renameCalls: { rel: string; newTitle: string }[] = [];
let nextRenamedRel = "";

vi.mock("../bindings", () => ({
  commands: {
    saveNote: (
      rel: string,
      _fm: unknown,
      body: string,
      expected: string | null,
    ) => {
      saveCalls.push({ rel, body, expected });
      const conflict = nextIsConflict;
      nextIsConflict = false;
      return new Promise((resolve) => {
        releaseSave = () =>
          resolve({
            status: "ok",
            data: { stamp: conflict ? "남이-쓴-지문" : "새-지문", conflict },
          });
      });
    },
    renameNote: (rel: string, newTitle: string) => {
      renameCalls.push({ rel, newTitle });
      return new Promise((resolve) => {
        releaseRename = () =>
          resolve({ status: "ok", data: nextRenamedRel });
      });
    },
    readNote: async (rel: string) => ({
      status: "ok",
      data: {
        rel_path: rel,
        note_type: "free",
        frontmatter: {},
        body: "디스크에 있던 내용",
        stamp: "디스크-지문",
      },
    }),
    listNotes: async () => ({ status: "ok", data: [] }),
    noteSummary: async () => ({ status: "error", error: "없음" }),
    auditVault: async () => ({ status: "ok", data: [] }),
    flushIndexFiles: async () => ({ status: "ok", data: null }),
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
      stamp: "읽어온-지문",
    } as never,
    dirty: false,
    notes: [],
    externalChanged: false,
    forceOverwrite: false,
  });
}

describe("saveCurrent — 저장 중 편집", () => {
  beforeEach(() => {
    releaseSave = null;
    saveCalls.length = 0;
    nextIsConflict = false;
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

  /** 두 번째 저장이 첫 번째 저장 결과와 충돌하면 안 된다 —
   *  방금 내가 쓴 내용을 남의 것으로 오인하는 셈이다. */
  it("연달아 저장할 때 방금 쓴 지문을 들고 간다", async () => {
    openNote("처음");
    useVault.getState().setBody("첫 번째");

    const first = useVault.getState().saveCurrent();
    await vi.waitFor(() => expect(releaseSave).not.toBeNull());
    releaseSave!();
    await first;

    useVault.getState().setBody("두 번째");
    const second = useVault.getState().saveCurrent();
    await vi.waitFor(() => expect(saveCalls.length).toBe(2));
    releaseSave!();
    await second;

    expect(saveCalls[0].expected).toBe("읽어온-지문");
    expect(saveCalls[1].expected).toBe("새-지문");
  });
});

/** 같은 저장소를 두 곳에서 열어 두면 양쪽 다 화면에 든 본문을 통째로 써 넣는다.
 *  파일 감시 알림이 늦거나 묻히면 진 쪽의 수정은 흔적도 없이 사라졌다.
 *  이제 쓰기 직전에 파일 자신에게 다시 묻는다 — 알림에 기대지 않는 마지막 방어선. */
describe("saveCurrent — 다른 곳에서 먼저 고쳤을 때", () => {
  beforeEach(() => {
    releaseSave = null;
    saveCalls.length = 0;
    nextIsConflict = false;
    useVault.setState({ error: null });
  });

  it("충돌이면 덮어쓰지 않고 경고를 띄운 채 내 글자를 지킨다", async () => {
    openNote("처음");
    useVault.getState().setBody("내가 친 글자");

    nextIsConflict = true;
    const saving = useVault.getState().saveCurrent();
    await vi.waitFor(() => expect(releaseSave).not.toBeNull());
    releaseSave!();
    await saving;

    expect(useVault.getState().externalChanged).toBe(true);
    // 저장이 안 됐으므로 아직 쓸 게 남았고, 친 글자도 그대로여야 한다
    expect(useVault.getState().dirty).toBe(true);
    expect(useVault.getState().current?.body).toBe("내가 친 글자");
  });

  it('"내 편집 유지"를 고르면 그다음 저장은 검사 없이 덮어쓴다', async () => {
    openNote("처음");
    useVault.getState().setBody("내가 친 글자");

    nextIsConflict = true;
    const first = useVault.getState().saveCurrent();
    await vi.waitFor(() => expect(releaseSave).not.toBeNull());
    releaseSave!();
    await first;

    useVault.getState().dismissExternalChange();
    const second = useVault.getState().saveCurrent();
    await vi.waitFor(() => expect(saveCalls.length).toBe(2));
    releaseSave!();
    await second;

    // 검사를 건너뛰겠다는 뜻으로 지문을 주지 않는다
    expect(saveCalls[1].expected).toBeNull();
    expect(useVault.getState().dirty).toBe(false);
    expect(useVault.getState().forceOverwrite).toBe(false);
  });

  it("다시 불러오면 새 지문으로 갈아타고 강제 덮어쓰기도 푼다", async () => {
    openNote("처음");
    useVault.getState().dismissExternalChange();
    expect(useVault.getState().forceOverwrite).toBe(true);

    await useVault.getState().reloadCurrent();

    expect(useVault.getState().forceOverwrite).toBe(false);
    expect(useVault.getState().externalChanged).toBe(false);
  });
});

/** 제목을 바꾸는 백엔드 왕복이 도는 사이 계속 타이핑하면, 그 사이 자동저장이
 *  아직 화면에 남아 있는 옛 경로에 새 파일을 하나 더 만들어 버렸다
 *  ("새 제목=빈 글" + "옛 제목=본문 있는 글" 두 파일이 생기는 버그). */
describe("renameCurrent — 이름 바꾸는 동안 편집", () => {
  beforeEach(() => {
    releaseSave = null;
    releaseRename = null;
    saveCalls.length = 0;
    renameCalls.length = 0;
    nextIsConflict = false;
    nextRenamedRel = "Free/새 제목.md";
    useVault.setState({ error: null });
  });

  it("이름을 바꾸는 왕복 사이에 친 글자는 새 경로로만 저장된다", async () => {
    openNote("처음");

    const renaming = useVault.getState().renameCurrent("새 제목");
    await vi.waitFor(() => expect(releaseRename).not.toBeNull());
    expect(renameCalls[0]).toEqual({
      rel: "Free/메모.md",
      newTitle: "새 제목",
    });

    // 백엔드가 아직 응답하기 전 — 화면은 옛 경로를 들고 있다
    expect(useVault.getState().current?.rel_path).toBe("Free/메모.md");
    useVault.getState().setBody("이름 바꾸는 도중에 친 글자");
    expect(useVault.getState().dirty).toBe(true);

    releaseRename!();

    // 이름이 바뀌자마자 rel_path가 새 경로로 갈아 끼워지고, 도중에 친 글자는
    // 그 새 경로로 저장된다 — 옛 경로에는 아무것도 쓰지 않는다
    await vi.waitFor(() => expect(releaseSave).not.toBeNull());
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0].rel).toBe("Free/새 제목.md");
    expect(saveCalls[0].body).toBe("이름 바꾸는 도중에 친 글자");
    releaseSave!();

    await renaming;

    // openNote가 다시 읽어 들일 때도 새 경로 하나만 거친다 — 옛 경로에
    // 빈 파일을 만드는 별도의 저장은 없어야 한다
    expect(saveCalls).toHaveLength(1);
    expect(useVault.getState().current?.rel_path).toBe("Free/새 제목.md");
  });

  it("이름을 바꾸는 왕복 사이에 자동저장(Ctrl+S 등)이 겹쳐도 옛 경로에 파일을 만들지 않는다", async () => {
    openNote("처음");

    const renaming = useVault.getState().renameCurrent("새 제목");
    await vi.waitFor(() => expect(releaseRename).not.toBeNull());

    useVault.getState().setBody("도중에 친 글자");
    // 3초 자동저장 타이머나 Ctrl+S가 이 시점에 끼어든다고 가정
    const stray = useVault.getState().saveCurrent();

    releaseRename!();
    await vi.waitFor(() => expect(releaseSave).not.toBeNull());
    // 끼어든 저장이 옛 경로("Free/메모.md")로 새 파일을 만들지 않았는지 확인
    expect(saveCalls.every((c) => c.rel === "Free/새 제목.md")).toBe(true);
    releaseSave!();

    await Promise.all([renaming, stray]);
    expect(saveCalls.some((c) => c.rel === "Free/메모.md")).toBe(false);
  });
});
