import { emitTo } from "@tauri-apps/api/event";
import {
  getAllWebviewWindows,
  getCurrentWebviewWindow,
} from "@tauri-apps/api/webviewWindow";

/** 내가 바꾼 노트를 *다른* 창들에게만 알린다.
 *
 *  백엔드 watcher는 앱 자신의 쓰기를 자기쓰기로 억제하므로(watcher.rs), 창끼리는
 *  이렇게 직접 알려야 서로의 편집을 따라갈 수 있다. 브로드캐스트(`emit`)를 쓰면 내 창도
 *  이벤트를 되받아 "외부에서 수정됨" 경고가 잘못 뜨기 때문에 자기 자신은 제외한다. */
export async function notifyOtherWindows(rels: string[]): Promise<void> {
  try {
    const me = getCurrentWebviewWindow().label;
    const others = (await getAllWebviewWindows()).filter((w) => w.label !== me);
    await Promise.all(
      others.map((w) => emitTo(w.label, "vault-external-change", rels)),
    );
  } catch {
    // 창 간 알림 실패는 무시 — 저장 자체는 이미 끝났다
  }
}
