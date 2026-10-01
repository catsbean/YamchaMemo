/** 업데이트 창에 보일 릴리스 설명(CHANGELOG.md의 그 판 절)을 줄로 나눈다.
 *
 *  마크다운을 통째로 그리지 않는다 — 쓰는 것은 목록·굵게·작은 제목 정도라, 그것만 알아보고
 *  나머지는 글자 그대로 둔다(렌더러를 들일 값이 없다). */
export type NoteLine = { kind: "item" | "heading" | "text"; text: string };

export function noteLines(body: string | null | undefined): NoteLine[] {
  if (!body) return [];
  const out: NoteLine[] = [];
  for (const raw of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim();
    const item = line.match(/^[-*]\s+(.*)$/);
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (item) out.push({ kind: "item", text: plain(item[1]) });
    else if (heading) out.push({ kind: "heading", text: plain(heading[1]) });
    else out.push({ kind: "text", text: plain(line) });
  }
  return out;
}
