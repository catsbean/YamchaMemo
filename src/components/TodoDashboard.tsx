import { useEffect, useMemo, useState } from "react";
import { commands, type TodoItem } from "../bindings";
import { typeLabel, useVault } from "../stores/vault";
import { addDays, weekdayOf, ymd } from "../lib/date";
import {
  moveMenuItems,
  noteItemHandlers,
  useContextMenu,
} from "../lib/contextMenu";
import { openNoteWindow } from "../lib/trashWindow";
import { useImeInput } from "../lib/ime";
import ContextMenu from "./ContextMenu";
import NoteText from "./NoteText";

/** 노트 한 편에 딸린 할 일 묶음 — 화면은 "어디에 적힌 할 일인가"로 나눠 보여 준다.
 *  할 일만 줄줄이 늘어놓으면 무엇을 하다 적은 것인지 알 수 없다. */
interface Group {
  rel: string;
  noteType: string;
  title: string;
  date: string;
  items: TodoItem[];
}

/** 완료한 할 일을 한 번에 받아 그리는 상한 — 훑어보는 자리라 미완보다 짧게 잡는다.
 *  넘치면 화면이 "외 N건"으로 알린다(총계는 백엔드가 따로 세어 준다). */
const DONE_LIMIT = 300;

/** 할 일 한 건을 가리키는 열쇠 — 어느 글의 몇 번째 줄인가 */
const keyOf = (t: TodoItem) => `${t.rel_path}#${t.index}`;

/** 할 일 탭 — vault 전체의 할 일을 한 자리에 모은다.
 *
 *  일지 안의 할 일 목록(TodoList)과 다른 점은 **여러 노트를 가로지른다**는 것이다.
 *  그래서 여기서 하는 일도 그 자리에서 끝나는 것만 둔다 — 체크와, 적힌 글로 가기.
 *  고치고 지우는 일은 그 글에서 한다(맥락을 보고 판단할 일이라). */
export default function TodoDashboard() {
  const {
    todos,
    todoOpenTotal,
    todoDoneTotal,
    todosTruncated,
    schemas,
    notes,
    openNote,
    moveNoteTo,
    toggleTodoItem,
    addTodoToday,
  } = useVault();
  const [showDone, setShowDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const ctx = useContextMenu();
  const refreshTodos = useVault((s) => s.refreshTodos);

  // 탭에 들어올 때 한 번 다시 읽는다. 편집기에서 손으로 적어 넣은 체크박스는
  // 자동저장(refreshNote)만 타고 지나가서 이 목록에 아직 없을 수 있다.
  useEffect(() => {
    refreshTodos();
  }, [refreshTodos]);

  // 완료한 할 일은 **켤 때만** 받는다. 스토어가 늘 들고 다니지 않는 이유는
  // 완료가 훨씬 빨리 쌓이는데 평소에는 쓸 일이 없어서다(실측 근거는 스토어 주석).
  const [doneItems, setDoneItems] = useState<TodoItem[]>([]);
  const [doneTruncated, setDoneTruncated] = useState(false);
  const [loadingDone, setLoadingDone] = useState(false);
  useEffect(() => {
    if (!showDone) {
      setDoneItems([]);
      return;
    }
    let alive = true;
    setLoadingDone(true);
    commands.listTodos(DONE_LIMIT, true).then((r) => {
      if (!alive) return;
      if (r.status === "ok") {
        setDoneItems(r.data.items);
        setDoneTruncated(r.data.truncated);
      }
      setLoadingDone(false);
    });
    return () => {
      alive = false;
    };
    // todos가 바뀌었다는 건 누가 체크를 뒤집었다는 뜻이다 — 완료 쪽도 따라 바뀐다
  }, [showDone, todos]);

  const today = ymd(new Date());
  // 개수는 목록 길이가 아니라 백엔드가 센 값을 쓴다 — 목록은 상한에 걸려 잘릴 수 있다
  const remaining = todoOpenTotal;
  const doneCount = todoDoneTotal;

  /** 화면에 그릴 것 — 미완 + (켰으면) 완료.
   *
   *  **두 목록은 서로 다른 시점의 것이다.** 완료를 취소하면 미완 쪽이 먼저
   *  갱신되고 완료 쪽은 다시 받아 오기 전까지 같은 줄을 아직 들고 있어서,
   *  그대로 이으면 한 줄이 두 번 그려진다(같은 key). 미완 쪽을 새것으로 친다. */
  const visible = useMemo(() => {
    if (!showDone) return todos;
    const open = new Set(todos.map(keyOf));
    return [...todos, ...doneItems.filter((t) => !open.has(keyOf(t)))];
  }, [todos, doneItems, showDone]);

  const groups = useMemo(() => {
    const map = new Map<string, Group>();
    for (const t of visible) {
      let g = map.get(t.rel_path);
      if (!g) {
        g = {
          rel: t.rel_path,
          noteType: t.note_type,
          title: t.note_title,
          date: t.date,
          items: [],
        };
        map.set(t.rel_path, g);
      }
      g.items.push(t);
    }
    const out = [...map.values()];
    // 남은 게 있는 묶음이 위로, 그 다음 데일리, 그 안에서는 최근 날짜부터
    out.sort(
      (a, b) =>
        Number(a.items.every((t) => t.done)) -
          Number(b.items.every((t) => t.done)) ||
        Number(a.noteType !== "daily") - Number(b.noteType !== "daily") ||
        b.date.localeCompare(a.date) ||
        a.title.localeCompare(b.title, "ko"),
    );
    // 묶음 안에서는 미완을 위로, 그 안에서는 문서에 적힌 순서
    for (const g of out) {
      g.items.sort(
        (a, b) => Number(a.done) - Number(b.done) || a.index - b.index,
      );
    }
    return out;
  }, [visible]);

  /** 새 할 일은 오늘 일지로 — 오늘 일지가 없으면 만들어서 넣는다 */
  async function add(value?: string) {
    const text = (value ?? addIme.value()).trim();
    if (busy || !text) return;
    setBusy(true);
    try {
      await addTodoToday(text);
      addIme.clear();
    } finally {
      setBusy(false);
    }
  }
  const addIme = useImeInput((v) => add(v), "enter");

  async function toggle(t: TodoItem) {
    if (busy) return;
    setBusy(true);
    try {
      await toggleTodoItem(t);
    } finally {
      setBusy(false);
    }
  }

  /** 눌러서 그 글로 이동 (Ctrl+클릭 새 창, 우클릭 메뉴) */
  function openProps(rel: string) {
    const noteType = notes.find((n) => n.rel_path === rel)?.note_type ?? "";
    return noteItemHandlers(
      rel,
      () => openNote(rel),
      openNoteWindow,
      ctx.open,
      moveMenuItems(noteType, schemas, (id) => moveNoteTo(rel, id)),
    );
  }

  /** 데일리는 날짜가 곧 이름이다 — 오늘·어제만 말로 바꿔 준다 */
  function groupLabel(g: Group): string {
    if (g.noteType !== "daily") return g.title;
    const w = weekdayOf(g.date);
    if (g.date === today) return `오늘 · ${g.date} (${w})`;
    if (g.date === addDays(today, -1)) return `어제 · ${g.date} (${w})`;
    return `${g.date} (${w})`;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center gap-2 border-b border-neutral-200 px-6 py-3">
        <h1 className="text-lg font-bold">
          ☑ 할 일{" "}
          <span className="text-sm font-normal text-neutral-400">
            {remaining > 0 ? `${remaining}건 남음` : "다 끝냈습니다"}
          </span>
        </h1>
        <span className="flex-1" />
        <button
          className={`rounded border px-3 py-1.5 text-sm ${
            showDone
              ? "border-neutral-800 bg-neutral-800 text-white"
              : "border-neutral-300 text-neutral-600 hover:border-neutral-500 hover:text-neutral-900"
          }`}
          onClick={() => setShowDone((v) => !v)}
          title="완료한 할 일도 함께 보여줍니다"
        >
          {loadingDone
            ? "완료 불러오는 중…"
            : showDone
              ? "☑ 완료 보는 중"
              : "완료한 할 일 보기"}
          {doneCount > 0 && (
            <span className={showDone ? "text-neutral-300" : "text-neutral-400"}>
              {" "}
              {doneCount}
            </span>
          )}
        </button>
      </header>

      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-100 px-6 py-2">
        <span className="shrink-0 text-sm text-neutral-300">☐</span>
        <input
          className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-2.5 py-1 text-sm focus:border-neutral-500 focus:outline-none"
          placeholder="새 할 일을 적고 Enter — 오늘 일지에 담깁니다"
          defaultValue=""
          {...addIme.handlers}
        />
        <button
          className="shrink-0 rounded bg-emerald-500 px-3 py-1 text-sm text-white hover:bg-emerald-400 disabled:opacity-50"
          disabled={busy}
          onClick={() => add()}
        >
          추가
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {/* 상한에 걸려 잘렸으면 숨기지 않고 말한다 — 다 보여 준 척하는 목록이
            제일 나쁘다. 남은 것은 그 글에서 이어서 볼 수 있다 */}
        {(todosTruncated || (showDone && doneTruncated)) && (
          <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-2xs text-amber-700">
            할 일이 많아 최근 것부터 일부만 그렸습니다
            {todosTruncated && ` · 미완 ${todos.length}건 / 전체 ${remaining}건`}
            {showDone && doneTruncated &&
              ` · 완료 ${doneItems.length}건 / 전체 ${doneCount}건`}
            . 나머지는 각 글에서 볼 수 있습니다.
          </p>
        )}
        {groups.length === 0 && (
          <p className="mt-16 text-center text-sm text-neutral-400">
            {remaining === 0 && doneCount > 0
              ? "남은 할 일이 없습니다. 위 [완료한 할 일 보기]로 지난 것을 볼 수 있습니다."
              : "할 일이 없습니다. 위 칸에 적으면 오늘 일지에 담깁니다."}
          </p>
        )}

        {groups.map((g) => (
          <section key={g.rel} className="mb-4">
            <div className="mb-1 flex items-baseline gap-2">
              <button
                className="rounded px-1 text-sm font-semibold text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
                title="이 할 일이 적힌 글로 이동"
                {...openProps(g.rel)}
              >
                {g.noteType === "daily" ? "📅" : "📝"} {groupLabel(g)}
              </button>
              {g.noteType !== "daily" && (
                <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-3xs text-neutral-500">
                  {typeLabel(schemas, g.noteType)}
                </span>
              )}
              <span className="text-2xs text-neutral-400">
                {g.items.some((t) => !t.done)
                  ? `${g.items.filter((t) => !t.done).length}건 남음`
                  : "완료"}
              </span>
            </div>

            <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white">
              {g.items.map((t) => (
                <li
                  key={keyOf(t)}
                  className="group flex items-start gap-2 px-3 py-2 hover:bg-neutral-50"
                >
                  <button
                    className={`mt-0.5 shrink-0 text-sm ${
                      t.done
                        ? "text-emerald-500"
                        : "text-neutral-300 hover:text-emerald-500"
                    } disabled:opacity-50`}
                    disabled={busy}
                    title={t.done ? "완료 취소" : "완료 표시"}
                    onClick={() => toggle(t)}
                  >
                    {t.done ? "☑" : "☐"}
                  </button>
                  <NoteText
                    text={t.text}
                    className={`min-w-0 flex-1 text-sm ${
                      t.done ? "text-neutral-400 line-through" : "text-neutral-800"
                    }`}
                  />
                  <button
                    className="shrink-0 rounded px-1.5 py-0.5 text-2xs text-neutral-400 opacity-0 hover:bg-neutral-100 hover:text-neutral-700 focus-visible:opacity-100 group-hover:opacity-100"
                    title="적힌 글로 이동"
                    {...openProps(t.rel_path)}
                  >
                    열기 →
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {ctx.menu && <ContextMenu state={ctx.menu} onClose={ctx.close} />}
    </div>
  );
}
