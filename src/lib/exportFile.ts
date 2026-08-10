import { save } from "@tauri-apps/plugin-dialog";
import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
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

/** 인쇄할 문서를 넘겨 두는 자리.
 *
 *  창끼리 주소(`data:`)로 넘기지 않는 이유는 두 가지다. CSP가 `default-src 'self'`라
 *  웹뷰를 `data:` 주소로 보낼 수 없고, 한글이 섞인 문서는 `btoa`에 실리지도 않는다.
 *  두 창은 같은 origin이므로 localStorage가 그대로 공유된다. */
export const PRINT_DOC_KEY = "yamcha-print-doc";
/** 이미 떠 있는 인쇄 창에 "새 문서가 왔다"고 알리는 이름 */
export const PRINT_DOC_EVENT = "yamcha-print-doc";
const PRINT_LABEL = "print";

/** 인쇄 미리보기를 **별도 창**으로 띄운다.
 *
 *  예전에는 앱 화면에 숨긴 iframe을 얹어 인쇄했다. 미리보기가 본 창 위에 겹쳐 떠서
 *  닫는 단추가 어느 창의 것인지 헷갈렸고, 본 창 X를 눌러도 아무 반응이 없었다.
 *  창 자체를 나누면 그 혼동이 사라진다 — 인쇄 창을 닫아도 앱은 그대로다. */
export async function printHtml(html: string): Promise<void> {
  try {
    localStorage.setItem(PRINT_DOC_KEY, html);
  } catch {
    // 저장 공간을 넘길 만큼 긴 문서 — 왜 안 되는지는 알려 준다
    throw new Error(
      "인쇄할 문서가 너무 깁니다 — 기간을 좁히거나 HTML로 저장해 주세요.",
    );
  }

  // 인쇄를 여러 번 해도 창이 쌓이지 않게, 떠 있으면 그 창에 새 문서를 넘긴다
  const existing = await WebviewWindow.getByLabel(PRINT_LABEL);
  if (existing) {
    await emitTo(PRINT_LABEL, PRINT_DOC_EVENT);
    await existing.setFocus();
    return;
  }

  const w = new WebviewWindow(PRINT_LABEL, {
    url: "index.html?view=print",
    title: "인쇄 미리보기 — YamchaMemo",
    width: 900,
    height: 900,
    minWidth: 420,
    minHeight: 320,
    resizable: true,
  });
  w.once("tauri://error", (e) => console.error("인쇄 창 열기 실패", e));
}
