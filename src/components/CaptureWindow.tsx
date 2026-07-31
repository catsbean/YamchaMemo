import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { load } from "@tauri-apps/plugin-store";
import { commands, type CaptureTarget } from "../bindings";
import { isImeEnter } from "../lib/ime";

const LABELS: Record<CaptureTarget, string> = {
  Daily: "오늘 일지",
  Inbox: "수집함",
};

/** 전역 단축키로 뜨는 작은 담기 창.
 *
 *  앱 화면을 거치지 않으므로 스토어를 초기화하지 않는다 — 설정만 직접 읽고,
 *  담기는 커맨드 하나로 끝낸다. 담고 나면 스스로 닫힌다. */
export default function CaptureWindow() {
  const [text, setText] = useState("");
  const [target, setTarget] = useState<CaptureTarget>("Daily");
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    load("settings.json", { autoSave: true, defaults: {} }).then(async (s) => {
      const t = (await s.get<CaptureTarget>("captureTarget")) ?? "Daily";
      setTarget(t);
    });
    ref.current?.focus();
  }, []);

  async function close() {
    await getCurrentWindow().destroy();
  }

  async function save() {
    if (!text.trim() || busy) return;
    setBusy(true);
    const r = await commands.quickCapture(target, text);
    setBusy(false);
    if (r.status === "error") {
      setError(r.error);
      return;
    }
    // 담았다는 것만 잠깐 보여 주고 사라진다
    setDone(LABELS[target]);
    setTimeout(close, 700);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && !e.shiftKey && !isImeEnter(e)) {
      // Shift+Enter는 줄바꿈 — 여러 줄도 담을 수 있게
      e.preventDefault();
      save();
    }
  }

  if (done) {
    return (
      <div className="flex h-screen items-center justify-center bg-white text-sm text-neutral-600">
        {done}에 담았습니다
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-white">
      <textarea
        ref={ref}
        autoFocus
        className="flex-1 resize-none px-4 py-3 text-sm focus:outline-none"
        placeholder="담을 내용 — Enter로 담고, Shift+Enter는 줄바꿈, Esc는 취소"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {error && (
        <div className="px-4 pb-1 text-xs text-rose-600">{error}</div>
      )}
      <div className="flex items-center gap-2 border-t border-neutral-200 px-3 py-1.5">
        <span className="text-2xs text-neutral-400">담을 곳</span>
        {(["Daily", "Inbox"] as CaptureTarget[]).map((t) => (
          <button
            key={t}
            className={`rounded-full px-2 py-0.5 text-xs ${
              target === t
                ? "bg-neutral-800 text-white"
                : "text-neutral-600 hover:bg-neutral-100"
            }`}
            onClick={async () => {
              setTarget(t);
              const s = await load("settings.json", {
                autoSave: true,
                defaults: {},
              });
              await s.set("captureTarget", t);
            }}
          >
            {LABELS[t]}
          </button>
        ))}
        <button
          className="ml-auto rounded bg-neutral-800 px-3 py-0.5 text-xs text-white disabled:opacity-40"
          disabled={!text.trim() || busy}
          onClick={save}
        >
          담기
        </button>
      </div>
    </div>
  );
}
