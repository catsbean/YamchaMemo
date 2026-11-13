import { describe, expect, it } from "vitest";
import { applyPick, rangeBetween } from "./selection";

const ORDER = ["a", "b", "c", "d", "e"];
const set = (...xs: string[]) => new Set(xs);
const sorted = (s: Set<string>) => [...s].sort();

describe("범위", () => {
  it("둘 사이를 양 끝까지", () => {
    expect(rangeBetween(ORDER, "b", "d")).toEqual(["b", "c", "d"]);
  });
  it("거꾸로 눌러도 같다", () => {
    expect(rangeBetween(ORDER, "d", "b")).toEqual(["b", "c", "d"]);
  });
  it("시작한 줄이 목록에서 사라졌으면 누른 줄만", () => {
    expect(rangeBetween(ORDER, "없음", "c")).toEqual(["c"]);
  });
});

describe("한 번 누르기", () => {
  it("그냥 누르면 그 줄만 켜고 끈다", () => {
    expect(sorted(applyPick(set(), null, ORDER, "b", false))).toEqual(["b"]);
    expect(sorted(applyPick(set("b"), "b", ORDER, "b", false))).toEqual([]);
  });

  it("Shift — 마지막에 누른 줄부터 여기까지 켠다", () => {
    expect(sorted(applyPick(set("b"), "b", ORDER, "d", true))).toEqual(["b", "c", "d"]);
    // 위로 올라가도 된다
    expect(sorted(applyPick(set("d"), "d", ORDER, "a", true))).toEqual(["a", "b", "c", "d"]);
  });

  it("Shift — 따로 골라 둔 것은 그대로 둔다", () => {
    expect(sorted(applyPick(set("a", "c"), "c", ORDER, "e", true))).toEqual(["a", "c", "d", "e"]);
  });

  it("Shift — 마지막에 끈 줄에서 시작하면 그 사이를 끈다", () => {
    // b를 껐다가(anchor = b, 꺼짐) Shift로 d를 누르면 b~d가 꺼진다
    expect(sorted(applyPick(set("a", "c", "d", "e"), "b", ORDER, "d", true))).toEqual(["a", "e"]);
  });

  it("Shift인데 시작한 줄이 없으면 그냥 누른 것과 같다", () => {
    expect(sorted(applyPick(set(), null, ORDER, "c", true))).toEqual(["c"]);
    expect(sorted(applyPick(set("x"), "x", ORDER, "c", true))).toEqual(["c", "x"]);
  });
});
