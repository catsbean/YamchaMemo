import { describe, expect, it } from "vitest";
import { takeGroups } from "./useIncremental";

describe("묶음에서 앞의 몇 개만", () => {
  const groups: [string, number[]][] = [
    ["2026-09", [1, 2, 3]],
    ["2026-08", [4, 5]],
    ["2026-07", [6, 7, 8, 9]],
  ];

  it("묶음을 건너며 앞에서부터 센다", () => {
    expect(takeGroups(groups, 4)).toEqual([
      ["2026-09", [1, 2, 3]],
      ["2026-08", [4]],
    ]);
  });

  it("다 들어가면 그대로, 0이면 빈 목록", () => {
    expect(takeGroups(groups, 100)).toEqual(groups);
    expect(takeGroups(groups, 0)).toEqual([]);
  });
});
