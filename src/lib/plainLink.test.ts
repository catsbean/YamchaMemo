import { describe, expect, it } from "vitest";
import { plainLinkBlocked, plainLinkMatch } from "./plainLink";
import type { LinkOption } from "./resolveLink";

function opts(names: string[]): LinkOption[] {
  return names.map((label) => ({ label, insert: label, detail: "" }));
}

const NOTES = opts([
  "abc",
  "abcd",
  "역사 개론",
  "역사적 예수",
  "한국의 역사적 인물",
  "Clean Code",
  "책",
  "2026-11-12",
]);

function labels(before: string): string[] | null {
  return plainLinkMatch(NOTES, before)?.options.map((o) => o.label) ?? null;
}

describe("`[[` 없이 쓰다가 글 이름 찾기", () => {
  // 요청의 예 — abc라는 글이 있을 때 ab·abc를 치면 뜬다
  it("낱말 앞부터 맞으면 찾는다", () => {
    expect(labels("오늘 ab")).toEqual(["abc", "abcd"]);
    expect(labels("오늘 abc")).toEqual(["abc", "abcd"]);
    expect(labels("오늘 abcd")).toEqual(["abcd"]);
  });

  it("이름보다 길어지면 닫힌다 (abcedf, 조사가 붙은 abc를)", () => {
    expect(labels("오늘 abce")).toBeNull();
    expect(labels("오늘 abc를")).toBeNull();
  });

  it("한 글자로는 띄우지 않는다", () => {
    expect(labels("a")).toBeNull();
    expect(labels("역")).toBeNull();
    // 한 글자짜리 이름(책)은 이 길로는 추천되지 않는다 — 너무 자주 걸린다
    expect(labels("이 책")).toBeNull();
  });

  it("낱말 가운데는 보지 않는다 (`[[` 뒤에서만 가운데를 맞춘다)", () => {
    expect(labels("한국사적")).toBeNull();
    expect(labels("xabc")).toBeNull();
    // `역사적`은 `역사적 예수`의 앞이지 `한국의 역사적 인물`의 앞이 아니다
    expect(labels("그 역사적")).toEqual(["역사적 예수"]);
  });

  it("여러 낱말 이름은 띄어쓰기를 넘어 이어 맞춘다", () => {
    expect(labels("어제 역사적 예")).toEqual(["역사적 예수"]);
    expect(plainLinkMatch(NOTES, "어제 역사적 예")).toMatchObject({ from: 3, typed: "역사적 예" });
    expect(labels("한국의 역사적 인")).toEqual(["한국의 역사적 인물"]);
  });

  it("낱말이 끝나면(띄어쓰기) 이어질 이름이 있을 때만 남는다", () => {
    expect(labels("abc ")).toBeNull();
    expect(labels("역사 ")).toEqual(["역사 개론"]);
  });

  it("영문은 대소문자를 가리지 않는다", () => {
    expect(labels("read clean c")).toEqual(["Clean Code"]);
  });

  it("문장부호 뒤도 낱말의 시작이다", () => {
    expect(labels("(abc")).toEqual(["abc", "abcd"]);
    expect(labels("참고:abc")).toEqual(["abc", "abcd"]);
  });

  it("날짜 모양 이름(일지)은 추천하지 않는다", () => {
    expect(labels("2026-11")).toBeNull();
  });

  it("바꿀 자리를 알려 준다", () => {
    expect(plainLinkMatch(NOTES, "오늘 ab")).toMatchObject({ from: 3, typed: "ab" });
  });
});

describe("추천을 띄우지 않는 자리", () => {
  it("닫히지 않은 [[ 안", () => {
    expect(plainLinkBlocked("참고 [[ab")).toBe(true);
    expect(labels("참고 [[ab")).toBeNull();
    // 닫힌 링크 뒤는 평범한 글이다
    expect(labels("[[abcd]] 그리고 ab")).toEqual(["abc", "abcd"]);
  });

  it("인라인 코드 안", () => {
    expect(labels("명령은 `ab")).toBeNull();
    expect(labels("`x` 다음 ab")).toEqual(["abc", "abcd"]);
  });

  it("제목 줄", () => {
    expect(labels("## ab")).toBeNull();
  });

  it("주소·태그", () => {
    expect(labels("https://abc")).toBeNull();
    expect(labels("www.abc")).toBeNull();
    expect(labels("#abc")).toBeNull();
  });
});

describe("후보가 많을 때의 속도", () => {
  it("1만 5천 개에서 글자 하나에 1ms 남짓 (색인을 만든 뒤)", () => {
    const many = opts(Array.from({ length: 15000 }, (_, i) => `노트 ${i} 역사적 기록 ${i % 97}`));
    const t0 = performance.now();
    plainLinkMatch(many, "오늘 노트 1"); // 처음 한 번은 색인을 만든다
    const first = performance.now() - t0;
    const t1 = performance.now();
    for (let i = 0; i < 100; i++) plainLinkMatch(many, `오늘 본 것은 노트 ${i}`);
    const each = (performance.now() - t1) / 100;
    console.log("plainLinkMatch 15000개:", { first, each });
    expect(each).toBeLessThan(16);
  });
});
