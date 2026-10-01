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

  it("들여 쓴 줄은 앞 항목에 이어 붙인다", () => {
    const body = "- **문제가 생기면** — 진단 정보를\n  복사할 수 있습니다.\n- 다음 항목";
    expect(noteLines(body)).toEqual([
      { kind: "item", text: "문제가 생기면 — 진단 정보를 복사할 수 있습니다." },
      { kind: "item", text: "다음 항목" },
    ]);
  });

  it("설명이 없으면 빈 목록", () => {
    expect(noteLines("")).toEqual([]);
    expect(noteLines(undefined)).toEqual([]);
  });
});
