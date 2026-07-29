import { useVault } from "../stores/vault";

/** `[[타깃]]`, `[[타깃|표시]]`, `[[타깃#섹션]]` */
const WIKILINK = /\[\[([^[\]|#]+)(#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/g;

/** 본문 조각을 그리되 `[[위키링크]]`는 눌러서 이동할 수 있게 만든다.
 *
 *  기록·할 일 카드는 마크다운 원문이 아니라 다듬은 텍스트를 보여 주는 자리라,
 *  그냥 두면 링크가 대괄호째 글자로만 남는다. 편집기(원문 편집)에서는
 *  Ctrl+클릭으로 이동하지만, 보기 화면에서는 그냥 눌러서 가는 게 자연스럽다. */
export default function NoteText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const openByTitle = useVault((s) => s.openByTitle);

  const parts: (string | { target: string; label: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(WIKILINK)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const target = m[1].trim();
    parts.push({ target, label: (m[3] ?? m[1]).trim() });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));

  return (
    <p className={className}>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          p
        ) : (
          <button
            key={i}
            className="rounded text-violet-600 underline decoration-violet-300 underline-offset-2 hover:bg-violet-50 hover:decoration-violet-500"
            onClick={() => openByTitle(p.target)}
            title={`${p.target}(으)로 이동`}
          >
            {p.label}
          </button>
        ),
      )}
    </p>
  );
}
