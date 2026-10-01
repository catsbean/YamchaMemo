// 화면 쪽 로그 (8-2) — 백엔드의 로그 파일(`applog.rs`)에 한 줄씩 보탠다.
//
// 남기는 것: 실패한 커맨드(이름과 오류 문장), 렌더 오류(ErrorBoundary), 잡히지 않은 예외, 업데이트 결과.
// 노트 본문은 넘기지 않는다. 기록이 실패해도 아무 일도 일어나지 않는다(앱을 막지 않는다).
import { commands } from "../bindings";

export type LogLevel = "info" | "warn" | "error";

/** 같은 줄이 쏟아질 때 로그가 그것으로 차지 않게 — 같은 내용은 이 간격 안에 한 번만 */
const REPEAT_MS = 5_000;
const lastSent = new Map<string, number>();

export function logClient(level: LogLevel, message: string, now = Date.now()) {
  const key = `${level}|${message}`;
  const prev = lastSent.get(key);
  if (prev !== undefined && now - prev < REPEAT_MS) return;
  lastSent.set(key, now);
  if (lastSent.size > 200) lastSent.clear();
  // 로그 커맨드 자체는 감싸지 않은 원본을 부른다 (실패해도 다시 로그하지 않게)
  original.logClient?.(level, message).catch(() => {});
}

/** 감싸기 전의 커맨드 — 로그·진단 커맨드는 이걸로 부른다 */
const original: Partial<typeof commands> = { logClient: commands.logClient };

/** 로그를 남기지 않는 커맨드 — 로그 자신과, 실패가 흔하고 뜻 없는 확인용 */
const QUIET = new Set(["logClient", "logFilePath", "diagnostics"]);

/** `commands`의 각 커맨드를 감싸, `{status: "error"}`가 돌아오면 이름과 함께 로그에 남긴다.
 *
 *  커맨드마다 로그를 다는 대신 여기 한 곳에서 — 화면이 오류를 띄우는 길은 여럿(스토어 `guard`, 컴포넌트의
 *  `r.status === "error"` 분기)이지만 커맨드를 거치는 길은 하나다. 파일 오류의 원문은 백엔드가 따로
 *  남긴다(`with_ctx`). */
export function wrapCommands(target: Record<string, unknown> = commands as Record<string, unknown>) {
  for (const [name, fn] of Object.entries(target)) {
    if (typeof fn !== "function" || QUIET.has(name)) continue;
    const call = fn as (...args: unknown[]) => Promise<unknown>;
    target[name] = async (...args: unknown[]) => {
      const r = await call(...args);
      if (r && typeof r === "object" && (r as { status?: unknown }).status === "error") {
        logClient("warn", `${name} 실패: ${String((r as { error: unknown }).error)}`);
      }
      return r;
    };
  }
}

/** 앱(창)마다 한 번 — 커맨드 감싸기 */
export function installErrorLogging() {
  wrapCommands();
}

/** 오류를 한 줄 설명으로 — 스택이 있으면 앞 몇 줄만 */
export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const stack = (e.stack ?? "").split("\n").slice(0, 6).join("\n");
    return stack.includes(e.message) ? stack : `${e.message}\n${stack}`;
  }
  return String(e);
}
