import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sectionOf } from "./changelog.mjs";

const md = `# 바뀐 내용

설명 문단.

## 0.7.10

- 열 번째

## 0.7.1 — 2026-10-02

- 첫째
- 둘째

## 0.7.0

- 예전

## 0.6.9
`;

describe("CHANGELOG 절 뽑기", () => {
  it("그 판의 본문만, 날짜 꼬리가 붙어도", () => {
    expect(sectionOf(md, "0.7.1")).toBe("- 첫째\n- 둘째");
  });

  it("0.7.1을 찾으며 0.7.10을 잡지 않는다", () => {
    expect(sectionOf(md, "0.7.10")).toBe("- 열 번째");
    expect(sectionOf(md, "0.7.1")).not.toContain("열 번째");
  });

  it("마지막 절도, CRLF여도", () => {
    expect(sectionOf(md.replace(/\n/g, "\r\n"), "0.7.0")).toBe("- 예전");
  });

  it("없거나 비면 null — 빈 설명으로 내보내지 않는다", () => {
    expect(sectionOf(md, "9.9.9")).toBeNull();
    expect(sectionOf(md, "0.6.9")).toBeNull();
  });

  it("저장소의 CHANGELOG.md에 지금 판의 절이 있다", () => {
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    expect(sectionOf(readFileSync("CHANGELOG.md", "utf8"), version)).toBeTruthy();
  });
});
