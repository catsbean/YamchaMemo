import { useEffect, useRef, useState } from "react";
import { commands, type NoteContent, type NoteTodo } from "../bindings";
import { openTodoWindow } from "../lib/trashWindow";
import type { CalloutKind } from "../lib/callouts";
import { useImeInput } from "../lib/ime";
import NoteText from "./NoteText";

/** 일지 할 일 보기 — 체크·수정·삭제.
 *  화면에는 미완료를 위로 올리지만, 조작은 백엔드가 준 index(문서 순서)로 한다. */
export default function TodoList({
  relPath,
  body,
  onChanged,
  showOpenWindow = true,
  panel,
  onTogglePanel,
  big,
  onToggleBig,
  kinds = [],
}: {
  relPath: string;
  /** 본문 — 바뀔 때마다 목록을 다시 읽는 신호 */
  body: string;
  onChanged: (note: NoteContent) => void;
  /** 새 창으로 열기 버튼 표시 (할 일 창 안에서는 숨긴다) */
  showOpenWindow?: boolean;
  /** 지금 아래에 있는지 오른쪽에 있는지 (전환 버튼 표시용) */
  panel?: "bottom" | "right";
  onTogglePanel?: () => void;
  /** 크게 보기 상태와 토글 (기록 영역과 비율을 뒤집는다) */
  big?: boolean;
  onToggleBig?: () => void;
  /** 기록으로 옮길 때 고를 수 있는 콜아웃 종류 */
  kinds?: CalloutKind[];
}) {
  const [todos, setTodos] = useState<NoteTodo[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    commands.noteTodos(relPath).then((r) => {
      if (r.status === "ok") setTodos(r.data);
    });
  }, [relPath, body]);

  useEffect(() => {
    if (confirming === null) return;
    const t = setTimeout(() => setConfirming(null), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  /** 새 할 일 추가 — 일지 입력 바를 열지 않고 여기서 바로 */
  async function add(value?: string) {
    const text = (value ?? addIme.value()).trim();
    if (busy || !text) return;
    setBusy(true);
    setError("");
    const r = await commands.appendDailyEntry(relPath, "todo", text);
    if (r.status === "ok") {
      addIme.clear();
      onChanged(r.data);
    } else {
      setError(r.error);
    }
    setBusy(false);
  }

  const addIme = useImeInput((v) => add(v), "enter");
  // 수정 입력: 어떤 항목을 고치는 중인지 ref로 들고 훅에 넘긴다
  const editingRef = useRef<NoteTodo | null>(null);
  const editIme = useImeInput(
    (v) => {
      const t = editingRef.current;
      if (!t || !v.trim()) return;
      apply(() => commands.updateTodo(relPath, t.index, t.text, v.trim()));
    },
    "enter",
    () => setEditing(null),
  );

  async function apply(
    run: () => Promise<{ status: "ok"; data: NoteContent } | { status: "error"; error: string }>,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    const r = await run();
    if (r.status === "ok") {
      setEditing(null);
      setConfirming(null);
      onChanged(r.data);
    } else {
      setError(r.error);
    }
    setBusy(false);
  }

  // 미완료 먼저, 그 안에서는 문서 순서
  const sorted = [...todos].sort(
    (a, b) => Number(a.done) - Number(b.done) || a.index - b.index,
  );
  const remaining = todos.filter((t) => !t.done).length;

  return (
    <div className="flex h-full flex-col border-t border-neutral-200 bg-neutral-50/60">
      <div className="flex items-center justify-between gap-2 px-4 py-1">
        <span className="text-xs font-semibold text-neutral-600">
          ☑ 할 일{" "}
          <span className="font-normal text-neutral-400">
            {remaining > 0 ? `${remaining}건 남음` : "다 끝냈습니다"}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {error && <span className="text-[11px] text-rose-500">{error}</span>}
          {onToggleBig && (
            <button
              className="rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
              onClick={onToggleBig}
              title={big ? "원래 크기로" : "크게 보기"}
            >
              {big ? "▾" : "▴"}
            </button>
          )}
          {onTogglePanel && (
            <button
              className="rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
              onClick={onTogglePanel}
              title={
                panel === "right" ? "아래로 옮기기" : "오른쪽 패널로 옮기기"
              }
            >
              {panel === "right" ? "⤓" : "⇥"}
            </button>
          )}
          {showOpenWindow && (
            <button
              className="rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
              onClick={() => openTodoWindow(relPath)}
              title="할 일만 새 창으로 보기"
            >
              ⧉
            </button>
          )}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {todos.length === 0 ? (
          <p className="py-3 text-center text-xs text-neutral-400">
            위 입력창에서 [할 일]로 추가해보세요
          </p>
        ) : (
          <ul className="flex flex-col">
            {sorted.map((t) => (
              <li
                key={t.index}
                className="flex items-start gap-2 rounded px-2 py-0.5 hover:bg-white"
              >
                <button
                  className={`mt-0.5 shrink-0 text-sm ${
                    t.done ? "text-emerald-500" : "text-neutral-300 hover:text-emerald-500"
                  } disabled:opacity-50`}
                  disabled={busy}
                  title={t.done ? "완료 취소" : "완료 표시"}
                  onClick={() =>
                    apply(() =>
                      commands.toggleTodo(relPath, t.index, t.text, !t.done),
                    )
                  }
                >
                  {t.done ? "☑" : "☐"}
                </button>

                {editing === t.index ? (
                  <>
                  <select
                    className="shrink-0 rounded border border-neutral-300 bg-white px-1 py-0.5 text-[11px] text-neutral-700 focus:outline-none"
                    value="할 일"
                    title="기록으로 옮기면 완료 표시는 사라집니다"
                    onChange={(e) =>
                      apply(() =>
                        commands.changeKind(
                          relPath,
                          "todo",
                          t.index,
                          t.text,
                          e.target.value,
                        ),
                      )
                    }
                  >
                    <option value="할 일">☑ 할 일</option>
                    {kinds.map((k) => (
                      <option key={k.label} value={k.label}>
                        {k.icon} {k.label}로 옮기기
                      </option>
                    ))}
                  </select>
                  <input
                    autoFocus
                    className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-2 py-0.5 text-sm focus:outline-none"
                    defaultValue={t.text}
                    key={`edit-${t.index}`}
                    {...editIme.handlers}
                  />
                  </>
                ) : (
                  <NoteText
                    text={t.text}
                    className={`min-w-0 flex-1 text-sm ${
                      t.done ? "text-neutral-400 line-through" : "text-neutral-800"
                    }`}
                  />
                )}

                <span className="flex shrink-0 items-center gap-1">
                  {confirming === t.index ? (
                    <>
                      <button
                        className="rounded bg-rose-600 px-1.5 py-0.5 text-[11px] font-bold text-white hover:bg-rose-500 disabled:opacity-50"
                        disabled={busy}
                        onClick={() =>
                          apply(() => commands.deleteTodo(relPath, t.index, t.text))
                        }
                      >
                        삭제 확인
                      </button>
                      <button
                        className="rounded px-1 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100"
                        onClick={() => setConfirming(null)}
                      >
                        취소
                      </button>
                    </>
                  ) : editing === t.index ? (
                    <button
                      className="rounded px-1 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100"
                      onClick={() => setEditing(null)}
                    >
                      취소
                    </button>
                  ) : (
                    <>
                      <button
                        className="rounded px-1 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
                        onClick={() => {
                          setEditing(t.index);
                          setConfirming(null);
                        }}
                      >
                        수정
                      </button>
                      <button
                        className="rounded px-1 py-0.5 text-[11px] text-rose-400 hover:bg-neutral-100 hover:text-rose-600"
                        onClick={() => {
                          setConfirming(t.index);
                          setEditing(null);
                        }}
                      >
                        삭제
                      </button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-t border-neutral-200 px-3 py-1.5">
        <span className="shrink-0 text-sm text-neutral-300">☐</span>
        <input
          className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-2 py-0.5 text-sm focus:border-neutral-500 focus:outline-none"
          placeholder="할 일 추가 후 Enter"
          defaultValue=""
          {...addIme.handlers}
        />
        <button
          className="shrink-0 rounded bg-emerald-500 px-2 py-0.5 text-[11px] text-white hover:bg-emerald-400 disabled:opacity-50"
          disabled={busy}
          onClick={() => add()}
        >
          추가
        </button>
      </div>
    </div>
  );
}
