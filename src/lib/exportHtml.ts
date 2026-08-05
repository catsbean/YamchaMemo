// 마크다운 → 보기 좋은 HTML. "화면에 보이는 모양으로" 내보내기·인쇄에 쓴다.
//
// 범용 마크다운 변환기가 아니다. 이 앱이 실제로 만드는 문법만 다룬다:
// 제목 · 굵게/기울임/취소선/코드 · 목록/번호/체크박스 · 콜아웃 · 인용 · 링크 ·
// 이미지 · 위키링크 · 표(그대로 통과). 그래서 짧고 예측 가능하다.
// (경계가 많은 곳이라 `exportHtml.test.ts`가 지킨다)

import { kindByLabel } from "./callouts";

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c]);

/** `<a href>`·`<img src>`에 넣어도 되는 주소인가.
 *
 *  내보낸 HTML은 브라우저에서 열리고, 본문에는 웹에서 스크랩해 온 글이 섞일 수 있다.
 *  `[클릭](javascript:...)`이 그대로 링크가 되면 그걸 누르는 순간 스크립트가 돈다.
 *  그래서 **허용 목록**으로 간다 — 스킴이 없는 상대 경로(첨부 이미지)는 통과시키고,
 *  스킴이 있으면 아는 것만 통과시킨다. `data:`도 막는다(data:text/html이 같은 문제다). */
const SAFE_SCHEME = /^(https?|mailto|tel):/i;
function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  // 스킴처럼 보이는 앞부분이 있는가 (`javascript:`, `vbscript:`, `data:` …)
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  if (hasScheme && !SAFE_SCHEME.test(trimmed)) return null;
  return trimmed;
}

/** 한 줄 안의 서식. 코드(`)를 먼저 떼어 그 안은 건드리지 않는다. */
export function inlineToHtml(text: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  s = esc(s);
  // 이미지가 링크보다 먼저 (![]() 가 []() 에 먹히지 않게)
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (whole, alt: string, src: string) => {
    const safe = safeUrl(src);
    return safe === null ? whole : `<img src="${safe}" alt="${alt}">`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, label: string, href: string) => {
    // 거른 주소는 링크로 만들지 않고 쓴 그대로 둔다 — 조용히 지우면 뭐가 있었는지 모른다
    const safe = safeUrl(href);
    return safe === null ? whole : `<a href="${safe}">${label}</a>`;
  });
  // 위키링크는 링크할 곳이 없으니 표시명만 남긴다 (내보낸 파일은 혼자 다닌다)
  s = s.replace(
    /\[\[([^[\]|#]+)(?:#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/g,
    (_, target: string, alias?: string) =>
      `<span class="wl">${(alias ?? target).trim()}</span>`,
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/(^|\s)#([\p{L}\p{N}/_-]+)/gu, '$1<span class="tag">#$2</span>');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${esc(codes[Number(i)])}</code>`);
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const CHECK = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;

/** 본문(frontmatter 제외) → HTML 조각 */
export function bodyToHtml(body: string): string {
  const out: string[] = [];
  const lines = body.split("\n");
  let i = 0;

  /** 목록 덩어리를 한 번에 처리 (중첩은 두 칸 = 한 단계) */
  function takeList(): string {
    const items: { depth: number; html: string; ordered: boolean; check: boolean | null }[] = [];
    while (i < lines.length) {
      const m = lines[i].match(LIST);
      if (!m) break;
      const c = lines[i].match(CHECK);
      items.push({
        depth: Math.min(Math.floor(m[1].length / 2), 3),
        html: inlineToHtml(c ? c[3] : m[3]),
        ordered: /\d/.test(m[2]),
        check: c ? c[2].toLowerCase() === "x" : null,
      });
      i++;
    }
    const ordered = items[0].ordered;
    const body = items
      .map((it) => {
        const mark =
          it.check === null ? "" : `<span class="box">${it.check ? "☑" : "☐"}</span> `;
        const cls = it.check ? ' class="done"' : "";
        const pad = it.depth ? ` style="margin-left:${it.depth * 1.1}em"` : "";
        return `<li${cls}${pad}>${mark}${it.html}</li>`;
      })
      .join("\n");
    const tag = ordered ? "ol" : "ul";
    const noMarker = items.some((it) => it.check !== null) ? ' class="tasks"' : "";
    return `<${tag}${noMarker}>\n${body}\n</${tag}>`;
  }

  while (i < lines.length) {
    const line = lines[i];

    // 콜아웃: `> [!기록] 09:30` + 이어지는 `>` 줄들
    const co = line.match(/^\s*>\s*\[!([^\]]+)\]\s*(.*)$/);
    if (co) {
      const name = co[1].trim();
      const meta = co[2].trim();
      i++;
      const inner: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        inner.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      const icon = kindByLabel(name).icon;
      out.push(
        `<div class="callout co-${slug(name)}">` +
          `<div class="co-head">${icon} ${esc(name)}` +
          (meta ? ` <span class="co-meta">${esc(meta)}</span>` : "") +
          `</div>` +
          bodyToHtml(inner.join("\n")) +
          `</div>`,
      );
      continue;
    }

    // 일반 인용
    if (/^\s*>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        inner.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${bodyToHtml(inner.join("\n"))}</blockquote>`);
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const n = h[1].length;
      out.push(`<h${n}>${inlineToHtml(h[2])}</h${n}>`);
      i++;
      continue;
    }

    if (LIST.test(line)) {
      out.push(takeList());
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    // 문단 — 빈 줄까지 모은다
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*>/.test(lines[i]) && !LIST.test(lines[i]) && !/^#{1,6}\s/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${para.map(inlineToHtml).join("<br>")}</p>`);
  }

  return out.join("\n");
}

/** 콜아웃 이름 → CSS 클래스로 쓸 수 있는 꼬리표 (한글이라 코드포인트로) */
function slug(name: string): string {
  return [...name].map((c) => c.codePointAt(0)!.toString(36)).join("");
}

/** 콜아웃 이름 → 테두리 색 (인쇄해도 구분되도록 실제 색을 박아 넣는다) */
const CALLOUT_COLOR: Record<string, string> = {
  기록: "#0284c7",
  느낌: "#d97706",
  발췌: "#d97706",
  생각: "#0284c7",
  요약: "#059669",
  질문: "#7c3aed",
};

/** 혼자 다닐 수 있는 HTML 문서 한 장으로 감싼다.
 *  스타일을 안에 박아 넣어 어디서 열어도 같은 모양이고, 인쇄용 규칙도 함께 넣는다. */
/** 여러 편을 한 문서로 묶는다 (책 여러 권을 한 번에 내보낼 때).
 *  편마다 새 페이지에서 시작해 인쇄물에서 서로 섞이지 않는다. */
export function joinSections(
  sections: { title: string; meta?: string; html: string }[],
): string {
  return sections
    .map(
      (s, i) =>
        `<section${i > 0 ? ' style="break-before:page"' : ""}>\n` +
        `<h1>${esc(s.title)}</h1>\n` +
        (s.meta ? `<p class="doc-meta">${esc(s.meta)}</p>\n` : "") +
        `${s.html}\n</section>`,
    )
    .join("\n");
}

export function wrapDocument(
  title: string,
  bodyHtml: string,
  meta?: string,
): string {
  const calloutCss = Object.entries(CALLOUT_COLOR)
    .map(([name, color]) => `.co-${slug(name)}{border-left-color:${color}}
.co-${slug(name)} .co-head{color:${color}}`)
    .join("\n");

  return `<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 3rem 2rem; max-width: 42rem;
    font: 15px/1.75 "Pretendard", "Malgun Gothic", -apple-system, sans-serif;
    color: #1f2937; background: #fff;
    word-break: keep-all; overflow-wrap: break-word;
  }
  h1 { font-size: 1.75rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.3rem; margin: 2rem 0 .5rem; padding-bottom: .25rem;
       border-bottom: 1px solid #e5e7eb; }
  h3 { font-size: 1.1rem; margin: 1.5rem 0 .4rem; }
  h4, h5, h6 { font-size: 1rem; margin: 1.2rem 0 .3rem; }
  p { margin: .6rem 0; }
  .doc-meta { margin: 0 0 2rem; color: #6b7280; font-size: .8125rem; }
  ul, ol { margin: .6rem 0; padding-left: 1.4rem; }
  ul.tasks { list-style: none; padding-left: .2rem; }
  li { margin: .2rem 0; }
  li.done { color: #9ca3af; text-decoration: line-through; }
  .box { color: #059669; }
  blockquote { margin: .8rem 0; padding: .1rem 0 .1rem .9rem;
               border-left: 3px solid #d1d5db; color: #4b5563; }
  .callout { margin: .9rem 0; padding: .6rem .9rem; border-left: 3px solid #9ca3af;
             background: #f9fafb; border-radius: 0 6px 6px 0; }
  .callout p:first-of-type { margin-top: 0; }
  .callout p:last-child { margin-bottom: 0; }
  .co-head { font-weight: 600; font-size: .8125rem; margin-bottom: .3rem; color: #4b5563; }
  .co-meta { font-weight: 400; opacity: .7; }
  ${calloutCss}
  code { background: #f3f4f6; padding: .1em .3em; border-radius: 3px;
         font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .9em; }
  a { color: #2563eb; }
  .wl { color: #7c3aed; }
  .tag { color: #7c3aed; }
  img { max-width: 100%; border-radius: 6px; }
  table { border-collapse: collapse; margin: .8rem 0; }
  th, td { border: 1px solid #e5e7eb; padding: .3rem .6rem; text-align: left; }
  hr { border: 0; border-top: 1px solid #e5e7eb; margin: 2rem 0; }

  /* 인쇄용 머리글·바닥글 — 화면에서는 감춘다 */
  .print-head, .print-foot { display: none; }

  @media print {
    /* 여백을 0으로 두면 브라우저가 넣던 머리글·바닥글(문서 제목·URL·시각)이
       그려질 자리가 없어져 사라진다. 그 자리를 우리가 직접 채운다 —
       안 그러면 바닥에 tauri.localhost가 찍힌다. */
    @page { margin: 0; }
    body { padding: 20mm 16mm 18mm; max-width: none; font-size: 11pt; }

    /* fixed 요소는 인쇄 시 페이지마다 반복된다 */
    .print-head, .print-foot {
      display: block; position: fixed; left: 16mm; right: 16mm;
      font-size: 9pt; color: #9ca3af;
    }
    .print-head { top: 9mm; text-align: right; }
    .print-foot { bottom: 9mm; }

    /* 제목이 페이지 끝에 홀로 남지 않게 */
    h1, h2, h3 { break-after: avoid; }
    .callout, blockquote, li, img { break-inside: avoid; }
    a { color: inherit; text-decoration: none; }
  }
</style>
<div class="print-head">${esc(printStamp())}</div>
<div class="print-foot">YamchaMemo</div>
<h1>${esc(title)}</h1>
${meta ? `<p class="doc-meta">${esc(meta)}</p>` : ""}
${bodyHtml}
</html>
`;
}

/** 인쇄 머리글에 찍을 날짜와 시각 — 24시간제 (`2026-08-03 14:05`).
 *  브라우저가 넣는 값은 로캘을 따라 "오후 2:05"로 나와서 직접 만든다. */
export function printStamp(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ` +
    `${p(at.getHours())}:${p(at.getMinutes())}`
  );
}
