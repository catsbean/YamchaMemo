import { describe, expect, it } from "vitest";
import { bodyToHtml, inlineToHtml, wrapDocument } from "./exportHtml";

describe("한 줄 서식", () => {
  it("굵게·기울임·취소선·코드", () => {
    expect(inlineToHtml("**굵게** *기울임* ~~취소~~ `코드`")).toBe(
      "<strong>굵게</strong> <em>기울임</em> <del>취소</del> <code>코드</code>",
    );
  });

  it("코드 안의 별표는 서식으로 보지 않는다", () => {
    expect(inlineToHtml("`**그대로**`")).toBe("<code>**그대로**</code>");
  });

  it("HTML로 새는 글자를 막는다", () => {
    expect(inlineToHtml('<script>a & b"')).toBe("&lt;script&gt;a &amp; b&quot;");
  });

  it("링크와 이미지", () => {
    expect(inlineToHtml("[야차](https://a.b)")).toBe(
      '<a href="https://a.b">야차</a>',
    );
    expect(inlineToHtml("![](img/a.png)")).toBe('<img src="img/a.png" alt="">');
  });

  it("위키링크는 표시명만 남긴다 (내보낸 파일은 혼자 다닌다)", () => {
    expect(inlineToHtml("[[클린 코드]]")).toBe('<span class="wl">클린 코드</span>');
    expect(inlineToHtml("[[클린 코드#3장|그 책]]")).toBe(
      '<span class="wl">그 책</span>',
    );
  });

  it("태그에 표시를 준다", () => {
    expect(inlineToHtml("오늘 #독서 했다")).toContain('<span class="tag">#독서</span>');
  });
});

describe("본문 덩어리", () => {
  it("제목과 문단", () => {
    expect(bodyToHtml("# 큰 제목\n\n첫 문단")).toBe("<h1>큰 제목</h1>\n<p>첫 문단</p>");
  });

  it("이어진 줄은 한 문단 안에서 줄바꿈", () => {
    expect(bodyToHtml("한 줄\n두 줄")).toBe("<p>한 줄<br>두 줄</p>");
  });

  it("글머리 목록", () => {
    expect(bodyToHtml("- 하나\n- 둘")).toBe("<ul>\n<li>하나</li>\n<li>둘</li>\n</ul>");
  });

  it("번호 목록", () => {
    expect(bodyToHtml("1. 하나\n2. 둘")).toContain("<ol>");
  });

  it("체크박스는 상자를 그리고 끝낸 것은 흐리게", () => {
    const html = bodyToHtml("- [ ] 할 일\n- [x] 끝낸 일");
    expect(html).toContain('<ul class="tasks">');
    expect(html).toContain('<span class="box">☐</span> 할 일');
    expect(html).toContain('<li class="done"><span class="box">☑</span> 끝낸 일</li>');
  });

  it("중첩 목록은 들여쓴다", () => {
    expect(bodyToHtml("- 하나\n  - 둘")).toContain('style="margin-left:1.1em"');
  });

  it("콜아웃은 이름·시각과 함께 상자가 된다", () => {
    const html = bodyToHtml("> [!기록] 09:30\n> 있었던 일");
    expect(html).toContain('class="callout co-');
    expect(html).toContain("🕘 기록");
    expect(html).toContain('<span class="co-meta">09:30</span>');
    expect(html).toContain("<p>있었던 일</p>");
  });

  it("콜아웃 안의 목록도 목록이 된다", () => {
    const html = bodyToHtml("> [!기록] 09:30\n> 장 볼 것\n> - 우유");
    expect(html).toContain("<li>우유</li>");
  });

  it("모르는 콜아웃 이름도 버리지 않는다", () => {
    expect(bodyToHtml("> [!회의] 14:00\n> 내용")).toContain("회의");
  });

  it("콜아웃이 아닌 인용은 인용으로", () => {
    expect(bodyToHtml("> 그냥 인용")).toBe(
      "<blockquote><p>그냥 인용</p></blockquote>",
    );
  });
});

describe("문서 한 장으로 감싸기", () => {
  it("제목·부제와 스타일이 안에 담긴다", () => {
    const doc = wrapDocument("클린 코드", "<p>본문</p>", "마틴 · 완독");
    expect(doc).toContain("<!doctype html>");
    expect(doc).toContain("<title>클린 코드</title>");
    expect(doc).toContain('<p class="doc-meta">마틴 · 완독</p>');
    expect(doc).toContain("@media print");
    expect(doc).toContain("<p>본문</p>");
  });

  it("제목에 들어간 꺾쇠도 막는다", () => {
    expect(wrapDocument("<b>제목", "", undefined)).toContain("&lt;b&gt;제목");
  });
});
