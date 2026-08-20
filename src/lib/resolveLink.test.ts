import { describe, expect, it } from "vitest";
import type { NoteSummary } from "../bindings";
import {
  aliasesOf,
  aliasShadowedBy,
  linkNamesOf,
  linkOptions,
  linkReaches,
  linkTargetOf,
  resolveLink,
} from "./resolveLink";

function note(
  rel_path: string,
  title: string,
  frontmatter: Record<string, unknown> = {},
): NoteSummary {
  return {
    rel_path,
    note_type: rel_path.split("/")[0].toLowerCase(),
    title,
    date: "2026-08-11",
    tags: [],
    char_count: 0,
    entry_count: 0,
    frontmatter,
  } as unknown as NoteSummary;
}

/** 결과를 "경로(맞은 이유)" 꼴로 눌러서 보기 좋게 */
function flat(hits: ReturnType<typeof resolveLink>) {
  return hits.map((h) => `${h.note.rel_path}(${h.via})`);
}

describe("링크 타깃 다듬기", () => {
  it("표시명·섹션·대괄호를 걷어낸다", () => {
    expect(linkTargetOf("[[클린 코드|그 책]]")).toBe("클린 코드");
    expect(linkTargetOf("클린 코드#3장")).toBe("클린 코드");
    expect(linkTargetOf("  [[ 클린 코드 ]]  ")).toBe("클린 코드");
    expect(linkTargetOf("[[]]")).toBe("");
  });
});

describe("별칭 읽기", () => {
  it("배열도 한 줄 문자열도 받고, 빈 값·중복은 버린다", () => {
    expect(aliasesOf(note("Free/a.md", "가", { aliases: ["비비풀", " BB ", "", "비비풀"] })))
      .toEqual(["비비풀", "BB"]);
    expect(aliasesOf(note("Free/a.md", "가", { aliases: "비비풀" }))).toEqual(["비비풀"]);
    expect(aliasesOf(note("Free/a.md", "가", { aliases: 12 }))).toEqual([]);
    expect(aliasesOf(note("Free/a.md", "가"))).toEqual([]);
  });
});

describe("위키링크 해석", () => {
  const 진짜 = note("Free/프로헥사디온 칼슘.md", "프로헥사디온 칼슘", {
    aliases: ["비비풀"],
  });
  const 파일명만 = note("Writing/파일명 노트.md", "");
  const notes = [진짜, 파일명만];

  it("제목으로 찾는다", () => {
    expect(flat(resolveLink(notes, "프로헥사디온 칼슘"))).toEqual([
      "Free/프로헥사디온 칼슘.md(title)",
    ]);
  });

  it("제목이 비어 있으면 파일명으로 찾는다", () => {
    expect(flat(resolveLink(notes, "파일명 노트"))).toEqual([
      "Writing/파일명 노트.md(file)",
    ]);
  });

  it("별칭으로도 같은 글에 닿는다", () => {
    const hits = resolveLink(notes, "비비풀");
    expect(flat(hits)).toEqual(["Free/프로헥사디온 칼슘.md(alias)"]);
    expect(hits[0].alias).toBe("비비풀");
  });

  it("없는 이름이면 빈 목록", () => {
    expect(resolveLink(notes, "없는 글")).toEqual([]);
    expect(resolveLink(notes, "   ")).toEqual([]);
  });

  /** 이게 별칭 기능의 안전핀이다 — 별칭이 남의 제목을 가로채면 안 된다 */
  it("같은 이름의 글이 있으면 별칭은 진다", () => {
    const 동명 = note("Free/비비풀.md", "비비풀");
    expect(flat(resolveLink([진짜, 동명], "비비풀"))).toEqual(["Free/비비풀.md(title)"]);
  });

  it("이름이 겹치면 후보를 전부 돌려준다", () => {
    const a = note("Free/중복노트.md", "중복노트");
    const b = note("회의록/중복노트.md", "중복노트");
    expect(flat(resolveLink([a, b], "중복노트"))).toEqual([
      "Free/중복노트.md(title)",
      "회의록/중복노트.md(title)",
    ]);
  });

  it("폴더까지 적으면 그 하나로 좁혀진다", () => {
    const a = note("Free/중복노트.md", "중복노트");
    const b = note("회의록/중복노트.md", "중복노트");
    expect(flat(resolveLink([a, b], "회의록/중복노트"))).toEqual([
      "회의록/중복노트.md(path)",
    ]);
    // `.md`를 붙여 써도 같다
    expect(flat(resolveLink([a, b], "Free/중복노트.md"))).toEqual(["Free/중복노트.md(path)"]);
  });

  it("경로로 못 찾으면 이름으로 다시 본다 (제목에 슬래시가 든 글)", () => {
    const s = note("Free/앞뒤.md", "앞/뒤");
    expect(flat(resolveLink([s], "앞/뒤"))).toEqual(["Free/앞뒤.md(title)"]);
  });
});

describe("만든 글이 그 링크에 닿는가", () => {
  it("제목이 그대로면 닿는다", () => {
    const n = note("Free/장보기.md", "장보기");
    expect(linkReaches([n], "장보기", "Free/장보기.md")).toBe(true);
  });

  /** 파일명 금지문자가 다듬어진 경우 — `회의: 3월`이 `회의 3월`이 된다 */
  it("제목이 다듬어졌으면 못 닿는다", () => {
    const n = note("Free/회의 3월.md", "회의 3월");
    expect(linkReaches([n], "회의: 3월", "Free/회의 3월.md")).toBe(false);
  });

  /** 제목 머릿글을 켜 둔 경우 — 모든 링크가 이렇게 된다 */
  it("제목 머릿글이 붙었으면 못 닿는다", () => {
    const n = note("Free/2026-08-11 장보기.md", "2026-08-11 장보기");
    expect(linkReaches([n], "장보기", "Free/2026-08-11 장보기.md")).toBe(false);
  });

  it("별칭을 심으면 다시 닿는다", () => {
    const n = note("Free/회의 3월.md", "회의 3월", { aliases: ["회의: 3월"] });
    expect(linkReaches([n], "회의: 3월", "Free/회의 3월.md")).toBe(true);
  });

  /** 같은 이름의 글이 따로 있으면 별칭을 심어도 그 글로 간다 —
   *  이때는 별칭이 소용없으므로 '닿는다'고 답하면 안 된다 */
  it("같은 이름의 글이 있으면 별칭을 심어도 못 닿는다", () => {
    const 새글 = note("Free/회의 3월.md", "회의 3월", { aliases: ["딴이름"] });
    const 먼저 = note("회의록/딴이름.md", "딴이름");
    expect(linkReaches([새글, 먼저], "딴이름", "Free/회의 3월.md")).toBe(false);
  });
});

describe("쓰이지 않는 별칭 가려내기", () => {
  const 다른글 = note("Free/비비풀.md", "비비풀");

  it("같은 이름의 글이 있으면 그 글의 이름을 돌려준다", () => {
    expect(aliasShadowedBy([다른글], "비비풀")).toBe("비비풀");
  });

  it("제목이 없으면 파일명으로 알려 준다", () => {
    const 무제 = note("Free/파일명뿐.md", "");
    expect(aliasShadowedBy([무제], "파일명뿐")).toBe("파일명뿐");
  });

  it("가리는 글이 없으면 null", () => {
    expect(aliasShadowedBy([다른글], "안 겹치는 이름")).toBeNull();
  });

  /** 다른 글이 같은 별칭을 쓰는 것은 가리는 게 아니다 — 그때는 고르는 창이 뜬다 */
  it("별칭끼리 겹치는 것은 가리는 것이 아니다", () => {
    const 별칭만 = note("Free/딴글.md", "딴글", { aliases: ["비비풀"] });
    expect(aliasShadowedBy([별칭만], "비비풀")).toBeNull();
  });
});

describe("자동완성 후보 이름", () => {
  it("파일명·제목·별칭을 겹치지 않게 모은다", () => {
    const n = note("Free/프로헥사디온 칼슘.md", "프로헥사디온 칼슘", {
      aliases: ["비비풀", "프로헥사디온 칼슘"],
    });
    expect(linkNamesOf(n)).toEqual(["프로헥사디온 칼슘", "비비풀"]);
  });
});

describe("자동완성 후보 만들기", () => {
  it("별칭도 후보에 넣고 어디로 가는지 적어 준다", () => {
    const n = note("Free/프로헥사디온 칼슘.md", "프로헥사디온 칼슘", {
      aliases: ["비비풀"],
    });
    expect(linkOptions([n])).toEqual([
      { label: "프로헥사디온 칼슘", insert: "프로헥사디온 칼슘", detail: "Free" },
      {
        label: "비비풀",
        insert: "비비풀",
        detail: "Free · 별칭 → 프로헥사디온 칼슘",
      },
    ]);
  });

  /** 어느 분류의 글인지가 이름만큼이나 단서다 — 겹치지 않아도 늘 보여 준다 */
  it("분류 이름을 꼬리말에 적고, 정의가 있으면 라벨로 적는다", () => {
    const n = note("Free/자유글.md", "자유글");
    expect(linkOptions([n], [{ id: "free", label: "자유노트" }])[0].detail).toBe(
      "자유노트",
    );
  });

  /** 고르는 순간에는 사용자가 어느 쪽인지 안다 — 그때 폴더까지 못 박아 둔다 */
  it("이름이 겹치면 폴더까지 적어 넣는다", () => {
    const a = note("Free/중복노트.md", "중복노트");
    const b = note("회의록/중복노트.md", "중복노트");
    expect(linkOptions([a, b])).toEqual([
      { label: "중복노트", insert: "Free/중복노트", detail: "Free" },
      { label: "중복노트", insert: "회의록/중복노트", detail: "회의록" },
    ]);
  });

  it("제목이 파일명과 다르면 둘 다 후보가 된다", () => {
    const n = note("Free/앞뒤.md", "앞/뒤");
    expect(linkOptions([n]).map((o) => o.label)).toEqual(["앞뒤", "앞/뒤"]);
  });
});
