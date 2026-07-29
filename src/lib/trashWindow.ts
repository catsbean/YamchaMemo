import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/** 노트 하나를 별도 창으로 연다 (이미 열려 있으면 앞으로 가져온다).
 *  창 라벨에 rel 경로를 넣어 같은 노트는 창이 하나만 뜨게 한다. */
export async function openNoteWindow(relPath: string): Promise<void> {
  // 라벨은 영숫자·하이픈만 허용되므로 경로를 인코딩해 넣는다
  const label = `note-${btoa(unescape(encodeURIComponent(relPath))).replace(
    /[^a-zA-Z0-9]/g,
    "",
  )}`;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }
  const title = relPath.split("/").pop()?.replace(/\.md$/, "") ?? "노트";
  const w = new WebviewWindow(label, {
    url: `index.html?view=note&rel=${encodeURIComponent(relPath)}`,
    title: `${title} — YamchaMemo`,
    width: 820,
    height: 720,
    minWidth: 420,
    minHeight: 320,
    resizable: true,
  });
  w.once("tauri://error", (e) => console.error("노트 창 열기 실패", e));
}

/** 일지의 할 일만 띄우는 좁은 창을 연다 (옆에 두고 체크하며 쓰기 좋게). */
export async function openTodoWindow(relPath: string): Promise<void> {
  const label = `todos-${btoa(unescape(encodeURIComponent(relPath))).replace(
    /[^a-zA-Z0-9]/g,
    "",
  )}`;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }
  const title = relPath.split("/").pop()?.replace(/\.md$/, "") ?? "할 일";
  const w = new WebviewWindow(label, {
    url: `index.html?view=todos&rel=${encodeURIComponent(relPath)}`,
    title: `할 일 — ${title}`,
    width: 380,
    height: 520,
    minWidth: 280,
    minHeight: 240,
    resizable: true,
  });
  w.once("tauri://error", (e) => console.error("할 일 창 열기 실패", e));
}

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
