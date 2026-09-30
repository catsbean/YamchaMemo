import { describe, expect, it } from "vitest";
import type { FieldDef, NoteSummary } from "../bindings";
import {
  MONTH_GROUP,
  NO_GROUP,
  UNGROUPED,
  defaultGroup,
  groupNotes,
  groupOptions,
  normalizeGroup,
} from "./group";

function note(title: string, date: string, fm: Record<string, unknown> = {}): NoteSummary {
  return {
    rel_path: `회의록/${title}.md`,
    note_type: "meeting",
    title,
    date,
    tags: [],
    char_count: 0,
    entry_count: 0,
    frontmatter: fm as NoteSummary["frontmatter"],
  };
}

function field(name: string, kind: FieldDef["kind"], extra: Partial<FieldDef> = {}): FieldDef {
  return { name, label: name, kind, required: false, options: [], in_list: false, ...extra } as FieldDef;
}

const fields = [
  field("tags", "tags", { in_list: true }),
  field("stage", "select", { options: ["준비", "진행", "끝"] }),
  field("attendees", "tags", { in_list: true }),
  field("due", "date", { in_list: true }),
  field("memo", "text"), // 목록에 안 보이는 칸 — 후보가 아니다
  field("cover", "image", { in_list: true }),
];
const options = groupOptions(fields);
const names = (groups: [string, NoteSummary[]][]) =>
  groups.map(([k, list]) => [k, list.map((n) => n.title)]);

describe("후보", () => {
  it("없음·월별 + 고르는 칸·목록에 보이는 칸, 태그·그림은 뺀다", () => {
    expect(options.map((o) => o.key)).toEqual(["none", "month", "stage", "attendees", "due"]);
    expect(options.find((o) => o.key === "due")?.byMonth).toBe(true);
  });

  it("일지만 월별이 기본이다", () => {
    expect(defaultGroup("daily")).toBe("month");
    expect(defaultGroup("free")).toBe("none");
  });

  it("없어진 칸을 가리키던 옛 설정은 기본으로 돌아간다", () => {
    expect(normalizeGroup("stage", options, "free")).toBe("stage");
    expect(normalizeGroup("지운칸", options, "free")).toBe("none");
    expect(normalizeGroup(undefined, options, "daily")).toBe("month");
  });
});

describe("묶기", () => {
  // 이미 정렬된 차례로 들어온다고 본다 — 칸 안의 차례는 그대로여야 한다
  const list = [
    note("가", "2026-09-10", { stage: "진행", attendees: ["민수", "[[지영]]"], due: "2026-10-01" }),
    note("나", "2026-09-02", { stage: "준비", attendees: ["지영"] }),
    note("다", "2026-08-30", { stage: "끝", due: "2026-09-15" }),
    note("라", "2026-08-01", {}),
    note("마", "2026-07-15", { stage: "진행" }),
  ];

  it("없음이면 한 칸에 그대로", () => {
    expect(names(groupNotes(list, "none", options))).toEqual([["", ["가", "나", "다", "라", "마"]]]);
  });

  it("월별은 최신 달부터", () => {
    expect(names(groupNotes(list, "month", options))).toEqual([
      ["2026-09", ["가", "나"]],
      ["2026-08", ["다", "라"]],
      ["2026-07", ["마"]],
    ]);
  });

  it("고르는 칸은 선택지 순서, 값이 없으면 미분류가 맨 뒤", () => {
    expect(names(groupNotes(list, "stage", options))).toEqual([
      ["준비", ["나"]],
      ["진행", ["가", "마"]],
      ["끝", ["다"]],
      [UNGROUPED, ["라"]],
    ]);
  });

  it("여러 값을 가진 칸은 값마다 들어간다 — 링크 괄호는 벗긴다", () => {
    expect(names(groupNotes(list, "attendees", options))).toEqual([
      ["민수", ["가"]],
      ["지영", ["가", "나"]],
      [UNGROUPED, ["다", "라", "마"]],
    ]);
  });

  it("날짜 칸은 달로 묶는다", () => {
    expect(names(groupNotes(list, "due", options))).toEqual([
      ["2026-10", ["가"]],
      ["2026-09", ["다"]],
      [UNGROUPED, ["나", "라", "마"]],
    ]);
  });

  it("모르는 키면 묶지 않는다", () => {
    expect(groupNotes(list, "없는칸", [NO_GROUP, MONTH_GROUP])).toHaveLength(1);
  });
});
