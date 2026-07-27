import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/** 휴지통 전용 창을 연다 (이미 열려 있으면 앞으로 가져온다). */
export async function openTrashWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel("trash");
  if (existing) {
    await existing.setFocus();
    return;
  }
  const w = new WebviewWindow("trash", {
    url: "index.html?view=trash",
    title: "휴지통 — YamchaMemo",
    width: 460,
    height: 640,
    minWidth: 360,
    minHeight: 420,
    resizable: true,
  });
  w.once("tauri://error", (e) => console.error("휴지통 창 열기 실패", e));
}
