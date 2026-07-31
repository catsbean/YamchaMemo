import {
  isRegistered,
  register,
  unregister,
} from "@tauri-apps/plugin-global-shortcut";
import { openCaptureWindow } from "./trashWindow";

/** 기본 단축키. 다른 프로그램과 부딪히면 설정에서 바꾼다. */
export const DEFAULT_CAPTURE_SHORTCUT = "CommandOrControl+Shift+Space";

/** 지금 등록해 둔 단축키 (해제할 때 필요하다 — 설정에서 바꾸면 옛것을 먼저 푼다) */
let current: string | null = null;

/** 전역 단축키를 건다. 성공하면 null, 실패하면 사람이 읽을 사유를 돌려준다.
 *
 *  실패를 조용히 넘기지 않는 이유: 다른 프로그램이 이미 쓰는 조합이면 등록이 안 되는데,
 *  사용자는 "켰는데 왜 안 되지"만 겪게 된다. */
export async function enableCapture(shortcut: string): Promise<string | null> {
  await disableCapture();
  try {
    if (await isRegistered(shortcut)) {
      return "다른 프로그램이 이미 쓰는 단축키입니다. 다른 조합으로 바꿔 주세요.";
    }
    await register(shortcut, (e) => {
      // 누를 때(Pressed)만 반응한다 — 뗄 때까지 처리하면 창이 두 번 뜬다
      if (e.state === "Pressed") openCaptureWindow();
    });
    current = shortcut;
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `단축키를 걸지 못했습니다: ${msg}`;
  }
}

/** 걸어 둔 단축키를 푼다. 꺼 두면 다른 프로그램의 단축키를 빼앗지 않는다. */
export async function disableCapture(): Promise<void> {
  if (!current) return;
  try {
    await unregister(current);
  } catch {
    // 이미 풀렸으면 그만이다
  }
  current = null;
}
