import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: [string, string][] = [];
vi.mock("../bindings", () => ({
  commands: {
    logClient: async (level: string, message: string) => {
      sent.push([level, message]);
      return null;
    },
  },
}));

const { logClient, wrapCommands } = await import("./log");

describe("화면 로그", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("실패한 커맨드만 이름과 함께 남기고, 결과는 그대로 돌려준다", async () => {
    const cmds: Record<string, unknown> = {
      readNote: async () => ({ status: "error", error: "노트를 찾을 수 없습니다: Free/없음.md" }),
      listNotes: async () => ({ status: "ok", data: [] }),
      coreVersion: async () => "0.7.1",
      logClient: async () => {
        throw new Error("감싸면 안 된다");
      },
    };
    wrapCommands(cmds);
    const r = await (cmds.readNote as () => Promise<unknown>)();
    expect(r).toEqual({ status: "error", error: "노트를 찾을 수 없습니다: Free/없음.md" });
    await (cmds.listNotes as () => Promise<unknown>)();
    expect(await (cmds.coreVersion as () => Promise<unknown>)()).toBe("0.7.1");
    await Promise.resolve();
    expect(sent).toEqual([["warn", "readNote 실패: 노트를 찾을 수 없습니다: Free/없음.md"]]);
    // 로그 커맨드는 감싸지 않는다 (감쌌다면 throw가 아니라 감싼 함수가 됐다)
    await expect((cmds.logClient as () => Promise<unknown>)()).rejects.toThrow("감싸면 안 된다");
  });

  it("같은 줄이 쏟아지면 5초 안엔 한 번만", async () => {
    logClient("warn", "같은 오류", 1_000);
    logClient("warn", "같은 오류", 2_000);
    logClient("warn", "같은 오류", 7_000);
    logClient("error", "같은 오류", 7_000);
    await Promise.resolve();
    expect(sent).toEqual([
      ["warn", "같은 오류"],
      ["warn", "같은 오류"],
      ["error", "같은 오류"],
    ]);
  });
});
