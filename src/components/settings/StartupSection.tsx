import { useMemo, useState } from "react";
import {
  useVault,
  type StartupMode,
} from "../../stores/vault";

const STARTUP_MODES: { value: StartupMode; label: string; desc: string }[] = [
  { value: "home", label: "홈", desc: "항상 홈 화면에서 시작" },
  {
    value: "last",
    label: "마지막 화면",
    desc: "지난번 종료할 때 보던 화면을 이어서 엽니다",
  },
  { value: "tab", label: "지정한 탭", desc: "고른 메뉴를 항상 먼저 엽니다" },
  { value: "note", label: "특정 글", desc: "고른 글을 항상 먼저 엽니다" },
];

/** 앱 시작시 열리는 화면 — 홈 / 마지막 화면 / 지정한 탭 / 특정 글.
 *  지정한 탭·글이 사라진 경우(분류 삭제, 노트 삭제·제목변경 등)의 대비는
 *  vault.init()에서 홈으로 대신 열고 startupNotice로 안내한다. */
export default function StartupSection() {
  const {
    startupMode,
    setStartupMode,
    startupTabId,
    setStartupTabId,
    startupNoteRel,
    setStartupNoteRel,
    schemas,
    notes,
  } = useVault();

  const tabOptions = useMemo(() => {
    const opts: { id: string; label: string }[] = [{ id: "home", label: "홈" }];
    for (const s of schemas.filter((x) => x.builtin)) {
      opts.push({ id: s.id, label: s.label });
      if (s.id === "book") opts.push({ id: "reading", label: "독서기록" });
    }
    opts.push({ id: "tags", label: "태그" });
    for (const s of schemas.filter((x) => !x.builtin)) {
      opts.push({ id: s.id, label: s.label });
    }
    return opts;
  }, [schemas]);

  const selectedNote = notes.find((n) => n.rel_path === startupNoteRel);
  const [pickingNote, setPickingNote] = useState(false);
  const [noteQuery, setNoteQuery] = useState("");
  const matches = useMemo(() => {
    const q = noteQuery.trim();
    if (!q) return [];
    return notes.filter((n) => n.title.includes(q)).slice(0, 8);
  }, [noteQuery, notes]);

  return (
    <section className="mb-5">
      <h3 className="mb-2 text-sm font-semibold text-neutral-600">시작 화면</h3>
      <div className="flex flex-col gap-1.5">
        {STARTUP_MODES.map((m) => (
          <label
            key={m.value}
            className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 ${
              startupMode === m.value
                ? "border-neutral-800 bg-neutral-50"
                : "border-neutral-200 hover:border-neutral-400"
            }`}
          >
            <input
              type="radio"
              className="mt-1"
              checked={startupMode === m.value}
              onChange={() => setStartupMode(m.value)}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{m.label}</span>
              <span className="block text-xs text-neutral-500">{m.desc}</span>

              {m.value === "tab" && startupMode === "tab" && (
                <select
                  className="mt-1.5 w-full rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-500 focus:outline-none"
                  value={startupTabId ?? ""}
                  onChange={(e) => setStartupTabId(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                >
                  <option value="" disabled>
                    탭을 고르세요
                  </option>
                  {tabOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}

              {m.value === "note" && startupMode === "note" && (
                <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
                  {selectedNote && !pickingNote ? (
                    <div className="flex items-center gap-2 rounded border border-neutral-300 bg-white px-2 py-1 text-xs">
                      <span className="min-w-0 flex-1 truncate">
                        {selectedNote.title}
                      </span>
                      <button
                        className="shrink-0 text-neutral-500 hover:text-neutral-800"
                        onClick={() => setPickingNote(true)}
                      >
                        변경
                      </button>
                    </div>
                  ) : (
                    <input
                      className="w-full rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-500 focus:outline-none"
                      placeholder="제목으로 검색…"
                      value={noteQuery}
                      onChange={(e) => setNoteQuery(e.target.value)}
                    />
                  )}
                  {(!selectedNote || pickingNote) && matches.length > 0 && (
                    <ul className="mt-1 flex flex-col gap-0.5 rounded border border-neutral-200 bg-white p-1">
                      {matches.map((n) => (
                        <li key={n.rel_path}>
                          <button
                            className="w-full truncate rounded px-1.5 py-1 text-left text-xs hover:bg-neutral-100"
                            onClick={() => {
                              setStartupNoteRel(n.rel_path);
                              setNoteQuery("");
                              setPickingNote(false);
                            }}
                          >
                            {n.title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}
