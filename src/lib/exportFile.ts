import { save } from "@tauri-apps/plugin-dialog";
import { commands } from "../bindings";

/** 저장 대화상자를 띄우고 고른 자리에 글을 쓴다. 취소하면 false. */
export async function saveTextAs(
  suggested: string,
  ext: string,
  extLabel: string,
  contents: string,
): Promise<boolean> {
  const path = await save({
    defaultPath: `${safeName(suggested)}.${ext}`,
    filters: [{ name: extLabel, extensions: [ext] }],
  });
  if (!path) return false;
  const r = await commands.writeExport(path, contents);
  if (r.status === "error") throw new Error(r.error);
  return true;
}

/** 파일 이름에 쓸 수 없는 글자를 걷어낸다 */
export function safeName(s: string): string {
  return (s.replace(/[\\/:*?"<>|]/g, "_").trim() || "내보내기").slice(0, 80);
}

/** 지금 창을 건드리지 않고 HTML만 인쇄한다.
 *
 *  숨긴 iframe에 문서를 넣고 그것만 인쇄하면 앱 화면은 그대로 있고
 *  인쇄 대화상자의 "PDF로 저장"으로 PDF까지 만들 수 있다.
 *  (앱에 PDF 렌더러를 넣는 대신 고른 방식 — 용량과 유지비를 아낀다) */
export function printHtml(html: string): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText =
    "position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0";
  document.body.appendChild(frame);

  const done = () => {
    // 인쇄 대화상자가 닫힌 뒤에 치운다 (너무 일찍 지우면 인쇄가 취소된다)
    setTimeout(() => frame.remove(), 1000);
  };

  frame.onload = () => {
    const w = frame.contentWindow;
    if (!w) return done();
    w.addEventListener("afterprint", done);
    // 글꼴·이미지가 자리를 잡은 뒤에 부른다
    setTimeout(() => {
      w.focus();
      w.print();
      // afterprint를 안 주는 웹뷰를 위한 안전망
      setTimeout(done, 60_000);
    }, 250);
  };
  frame.srcdoc = html;
}
