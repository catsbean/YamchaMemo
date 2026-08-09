import { describe, expect, it } from "vitest";
import {
  addDays,
  dateOf,
  daysBetween,
  isYmd,
  weekdayIndex,
  weekdayOf,
  ymd,
} from "./date";

describe("경로에서 날짜 뽑기", () => {
  it("중첩 폴더를 지나 파일 이름만 본다", () => {
    expect(dateOf("Daily/2026/07/2026-07-30.md")).toBe("2026-07-30");
  });

  it("확장자가 없어도 마지막 조각을 준다", () => {
    expect(dateOf("2026-07-30")).toBe("2026-07-30");
  });
});

describe("요일", () => {
  it("2026-08-03은 월요일이다", () => {
    expect(weekdayOf("2026-08-03")).toBe("월");
    expect(weekdayIndex("2026-08-03")).toBe(1);
  });

  it("일요일은 0 — 주가 월요일에 시작하는 것과 무관하게 실제 요일을 준다", () => {
    expect(weekdayIndex("2026-08-09")).toBe(0);
    expect(weekdayOf("2026-08-09")).toBe("일");
  });

  it("날짜꼴이 아니면 빈 문자열과 -1", () => {
    expect(weekdayOf("무제")).toBe("");
    expect(weekdayIndex("무제")).toBe(-1);
  });
});

describe("날짜 더하기", () => {
  it("달을 넘어간다", () => {
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
  });

  it("해를 넘어간다", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("윤년 2월을 안다", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });
});

describe("기간 길이", () => {
  it("양끝을 포함한다 — 같은 날이면 하루", () => {
    expect(daysBetween("2026-08-03", "2026-08-03")).toBe(1);
    expect(daysBetween("2026-08-03", "2026-08-09")).toBe(7);
  });

  it("서머타임이 없는 지역이 아니어도 달을 넘겨 셀 수 있다", () => {
    expect(daysBetween("2026-07-01", "2026-07-31")).toBe(31);
  });
});

describe("형식", () => {
  it("한 자리 달·일에 0을 채운다", () => {
    expect(ymd(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("isYmd는 고정폭만 받는다", () => {
    expect(isYmd("2026-01-05")).toBe(true);
    expect(isYmd("2026-1-5")).toBe(false);
    expect(isYmd("무제")).toBe(false);
  });
});
