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

const PRINT_FRAME_ID = "yamcha-print-frame";

/** 인쇄 미리보기가 떠 있는 동안 true */
let printing = false;

/** 인쇄 미리보기가 떠 있는가.
 *
 *  창 닫기 핸들러가 이걸 본다. 미리보기는 앱 화면 위에 겹쳐 뜨는데, 그걸 닫는
 *  동작이 창 닫기 요청으로 번져 **메모앱이 통째로 닫히는** 일이 있었다.
 *  인쇄 중에는 닫기 요청을 무시해 그 사고를 막는다. */
export function isPrinting(): boolean {
  return printing;
}

/** 지금 창을 건드리지 않고 HTML만 인쇄한다.
 *
 *  숨긴 iframe에 문서를 넣고 그것만 인쇄하면 앱 화면은 그대로 있고
 *  인쇄 대화상자의 "PDF로 저장"으로 PDF까지 만들 수 있다.
 *  (앱에 PDF 렌더러를 넣는 대신 고른 방식 — 용량과 유지비를 아낀다) */
export function printHtml(html: string): void {
  // 앞서 띄운 인쇄 프레임이 남아 있으면 치운다. 겹쳐 두면 미리보기가 어느 쪽을
  // 그리는지 엉키고, 닫아도 반응하지 않는 창이 남는다.
  document.getElementById(PRINT_FRAME_ID)?.remove();

  const frame = document.createElement("iframe");
  frame.id = PRINT_FRAME_ID;
  frame.setAttribute("aria-hidden", "true");
  // 화면 밖에 두되 **종이 크기 그대로** 만든다. 예전처럼 1px짜리로 두면
  // 미리보기가 그 1px을 기준으로 그려져 조작이 먹지 않는다.
  frame.style.cssText =
    "position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0";
  document.body.appendChild(frame);

  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    printing = false;
    // 인쇄 대화상자가 닫힌 뒤에 치운다 (너무 일찍 지우면 인쇄가 취소된다)
    setTimeout(() => frame.remove(), 1000);
  };

  frame.onload = () => {
    const w = frame.contentWindow;
    if (!w) return done();
    w.addEventListener("afterprint", done);
    // 글꼴·이미지가 자리를 잡은 뒤에 부른다
    setTimeout(() => {
      printing = true;
      w.focus();
      w.print();
      // afterprint를 안 주는 웹뷰를 위한 안전망
      setTimeout(done, 60_000);
    }, 250);
  };
  frame.srcdoc = html;
}
