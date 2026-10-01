import { describe, expect, it } from "vitest";
import { noteLines } from "./releaseNotes";

describe("릴리스 설명 줄", () => {
  it("목록·제목·문단을 가르고, 굵게·코드 표시는 벗긴다", () => {
    const body = "### 새로 생긴 것\r\n\r\n- **백업과 복원** — 설정 › 저장\n* `[통계]` 탭\n그냥 문장";
    expect(noteLines(body)).toEqual([
      { kind: "heading", text: "새로 생긴 것" },
      { kind: "item", text: "백업과 복원 — 설정 › 저장" },
      { kind: "item", text: "[통계] 탭" },
      { kind: "text", text: "그냥 문장" },
    ]);
  });

  it("설명이 없으면 빈 목록", () => {
    expect(noteLines("")).toEqual([]);
    expect(noteLines(undefined)).toEqual([]);
  });
});
