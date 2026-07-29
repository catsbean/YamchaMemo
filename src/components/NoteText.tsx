import { useVault } from "../stores/vault";

/** `[[타깃]]`, `[[타깃|표시]]`, `[[타깃#섹션]]` */
const WIKILINK = /\[\[([^[\]|#]+)(#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/g;

const CHECK = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;

export interface Item {
  depth: number;
  text: string;
  /** 번호 목록이면 그 번호, 아니면 null */
  num: string | null;
  /** 체크박스면 완료 여부, 아니면 null */
  done: boolean | null;
}
export type Block =
  | { kind: "text"; lines: string[] }
  | { kind: "list"; items: Item[] };

const depthOf = (indent: string) => Math.min(Math.floor(indent.length / 2), 3);

/** 줄들을 문단과 목록 덩어리로 나눈다.
 *  마크다운 원문은 그대로 두고 화면에서만 목록으로 보이게 하려는 것이다.
 *  (경계가 많아 `NoteText.test.ts`가 이 함수를 직접 돌린다) */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const line of text.split("\n")) {
    const check = line.match(CHECK);
    const ordered = !check && line.match(ORDERED);
    const bullet = !check && !ordered && line.match(BULLET);

    let item: Item | null = null;
    if (check) {
      item = {
        depth: depthOf(check[1]),
        text: check[3],
        num: null,
        done: check[2].toLowerCase() === "x",
      };
    } else if (ordered) {
      item = {
        depth: depthOf(ordered[1]),
        text: ordered[3],
        num: ordered[2],
        done: null,
      };
    } else if (bullet) {
      item = { depth: depthOf(bullet[1]), text: bullet[2], num: null, done: null };
    }

    const last = blocks[blocks.length - 1];
    if (item) {
      if (last?.kind === "list") last.items.push(item);
      else blocks.push({ kind: "list", items: [item] });
    } else {
      if (last?.kind === "text") last.lines.push(line);
      else blocks.push({ kind: "text", lines: [line] });
    }
  }
  return blocks;
}

/** 본문 조각을 그리되 `[[위키링크]]`는 눌러서 이동할 수 있게, `- 항목`은 목록으로 보이게 한다.
 *
 *  기록·할 일 카드는 마크다운 원문이 아니라 다듬은 텍스트를 보여 주는 자리다.
 *  그냥 두면 링크는 대괄호째, 목록은 `-`째 글자로 남는다. 파일은 표준 마크다운
 *  그대로 두고(다른 앱에서 열어도 목록이다) 화면에서만 제 모습으로 그린다. */
export default function NoteText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const openByTitle = useVault((s) => s.openByTitle);

  /** 한 줄 안의 위키링크를 링크 버튼으로 바꾼다 */
  function inline(line: string, key: string) {
    const parts: (string | { target: string; label: string })[] = [];
    let last = 0;
    for (const m of line.matchAll(WIKILINK)) {
      const at = m.index ?? 0;
      if (at > last) parts.push(line.slice(last, at));
      parts.push({ target: m[1].trim(), label: (m[3] ?? m[1]).trim() });
      last = at + m[0].length;
    }
    if (last < line.length) parts.push(line.slice(last));

    return parts.map((p, i) =>
      typeof p === "string" ? (
        p
      ) : (
        <button
          key={`${key}-${i}`}
          className="rounded text-violet-600 underline decoration-violet-300 underline-offset-2 hover:bg-violet-50 hover:decoration-violet-500"
          onClick={() => openByTitle(p.target)}
          title={`${p.target}(으)로 이동`}
        >
          {p.label}
        </button>
      ),
    );
  }

  const blocks = parseBlocks(text);

  // 목록이 없으면 예전처럼 문단 하나로 (줄바꿈은 호출한 쪽의 whitespace-pre-wrap이 살린다)
  if (blocks.length === 1 && blocks[0].kind === "text") {
    return <p className={className}>{inline(text, "t")}</p>;
  }

  return (
    <div className={className}>
      {blocks.map((b, bi) =>
        b.kind === "text" ? (
          <p key={bi}>{inline(b.lines.join("\n"), `t${bi}`)}</p>
        ) : (
          <ul key={bi} className="flex flex-col gap-0.5">
            {b.items.map((it, i) => (
              <li
                key={i}
                className="flex gap-1.5"
                style={{ paddingLeft: `${it.depth * 0.9}rem` }}
              >
                <span
                  className={`shrink-0 select-none ${
                    it.done === null ? "text-neutral-400" : ""
                  }`}
                >
                  {it.done === null ? (it.num ? `${it.num}.` : "•") : it.done ? "☑" : "☐"}
                </span>
                <span
                  className={`min-w-0 ${it.done ? "text-neutral-400 line-through" : ""}`}
                >
                  {inline(it.text, `l${bi}-${i}`)}
                </span>
              </li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}
