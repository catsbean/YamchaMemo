import { useState } from "react";
import type { EntryKind } from "../bindings";
import { useVault } from "../stores/vault";

const KINDS: {
  value: EntryKind;
  label: string;
  active: string;
  idle: string;
  bar: string;
}[] = [
  {
    value: "excerpt",
    label: "발췌",
    active: "bg-amber-500 text-white",
    idle: "bg-white text-amber-700 hover:bg-amber-100",
    bar: "bg-amber-50 border-amber-200",
  },
  {
    value: "thought",
    label: "생각",
    active: "bg-sky-500 text-white",
    idle: "bg-white text-sky-700 hover:bg-sky-100",
    bar: "bg-sky-50 border-sky-200",
  },
  {
    value: "summary",
    label: "요약",
    active: "bg-emerald-500 text-white",
    idle: "bg-white text-emerald-700 hover:bg-emerald-100",
    bar: "bg-emerald-50 border-emerald-200",
  },
  {
    value: "question",
    label: "질문",
    active: "bg-violet-500 text-white",
    idle: "bg-white text-violet-700 hover:bg-violet-100",
    bar: "bg-violet-50 border-violet-200",
  },
];

/** 독서기록 "기록 추가" 바 — 종류 버튼을 고르면 배경색이 바뀌고, 콜아웃으로 본문 끝에 누적 */
export default function ReadingEntryBar() {
  const appendEntry = useVault((s) => s.appendEntry);
  const [kind, setKind] = useState<EntryKind>("excerpt");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const current = KINDS.find((k) => k.value === kind) ?? KINDS[0];

  async function submit() {
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      await appendEntry(kind, text);
      setText("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`flex flex-col gap-1.5 border-b px-4 py-2 transition-colors ${current.bar}`}
    >
      <div className="flex gap-1.5">
        {KINDS.map((k) => (
          <button
            key={k.value}
            className={`rounded-md border border-current/10 px-3 py-1 text-sm font-medium transition-colors ${
              kind === k.value ? k.active : k.idle
            }`}
            onClick={() => setKind(k.value)}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="flex items-start gap-2">
        <textarea
          className="min-h-9 flex-1 resize-y rounded border border-neutral-300 bg-white px-2 py-1 text-sm focus:outline-none"
          placeholder={`${current.label} 기록을 입력하고 [추가] 또는 Ctrl+Enter — 본문 끝에 날짜와 함께 누적됩니다`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
          }}
        />
        <button
          className={`rounded px-3 py-1 text-sm text-white disabled:opacity-50 ${current.active} hover:opacity-90`}
          disabled={busy || !text.trim()}
          onClick={submit}
        >
          추가
        </button>
      </div>
    </div>
  );
}
