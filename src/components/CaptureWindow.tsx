import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands, type TagSuggestion } from "../bindings";
import { isImeEnter } from "../lib/ime";
import { notifyOtherWindows } from "../lib/windowSync";
import TagSuggestionRow from "./TagSuggestionRow";

/** 이미 본문에 적힌 인라인 #태그 — 이미 쓴 것을 다시 제안하지 않는다 */
function inlineTagsOf(text: string): string[] {
  return Array.from(text.matchAll(/#([\p{L}\p{N}/_-]+)/gu)).map((m) => m[1]);
}

/** 전역 단축키로 뜨는 작은 담기 창.
 *
 *  앱 화면을 거치지 않으므로 스토어를 초기화하지 않는다 — 설정만 직접 읽고,
 *  담기는 커맨드 하나로 끝낸다. 담고 나면 스스로 닫힌다. */
export default function CaptureWindow() {
  const [text, setText] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // 자동 태그 제안 — 창이 작으니 최대 3개, 타이핑이 멎고 500ms 뒤에만
  useEffect(() => {
    if (text.trim().length < 10) {
      setSuggestions([]);
      return;
    }
    const t = setTimeout(() => {
      commands
        .suggestTagsForText({
          title: "",
          body: text,
          note_type: "daily",
          genre: null,
          current_tags: inlineTagsOf(text),
        })
        .then((r) => {
          if (r.status === "ok") setSuggestions(r.data.slice(0, 3));
        });
    }, 500);
    return () => clearTimeout(t);
  }, [text]);

  /** 칩을 누르면 본문 끝에 인라인 태그로 붙는다 */
  function addTag(tag: string) {
    setText((t) => `${t.trimEnd()} #${tag}`);
    ref.current?.focus();
  }

  async function close() {
    await getCurrentWindow().destroy();
  }

  async function save() {
    if (!text.trim() || busy) return;
    setBusy(true);
    const r = await commands.quickCapture(text);
    setBusy(false);
    if (r.status === "error") {
      setError(r.error);
      return;
    }
    // 그 일지를 열어 둔 창이 있으면 지금 담은 줄이 바로 보이게 알린다.
    // 백엔드 watcher는 앱 자신의 쓰기를 억제하므로 창끼리 직접 알려야 한다.
    await notifyOtherWindows([r.data]);
    // 담았다는 것만 잠깐 보여 주고 사라진다
    setDone(true);
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
        오늘 일지에 담았습니다
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-white text-neutral-900">
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
      {suggestions.length > 0 && (
        <div className="px-4 pb-1">
          <TagSuggestionRow suggestions={suggestions} onAdd={addTag} className="" />
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-neutral-200 px-3 py-1.5">
        <span className="text-2xs text-neutral-400">오늘 일지의 기록으로 들어갑니다</span>
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
