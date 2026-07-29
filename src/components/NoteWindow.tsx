import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { commands, type DailyKind, type NoteContent } from "../bindings";
import type { EditorView } from "@codemirror/view";
import Editor from "../editor/Editor";
import EditorToolbar from "./EditorToolbar";
import { editorMenuItems } from "../editor/editorMenu";
import { useContextMenu, useSuppressNativeContextMenu } from "../lib/contextMenu";
import { splitBookBody, composeBookBody } from "../lib/book";
import { shortcutTextOf, useShortcut } from "../lib/shortcuts";
import { notifyOtherWindows } from "../lib/windowSync";
import ContextMenu from "./ContextMenu";
import DailyEntryBar from "./DailyEntryBar";

/** 노트 한 편만 띄우는 별도 창 — 두 글을 나란히 놓고 쓰거나 참고하며 쓸 때 쓴다.
 *  메인 창과 다른 webview지만 백엔드 vault는 프로세스 전역이라 그대로 읽고 쓴다. */
export default function NoteWindow({ relPath }: { relPath: string }) {
  const [note, setNote] = useState<NoteContent | null>(null);
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  // 서식 툴바가 명령을 실행하려면 CodeMirror 뷰가 필요하다
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const ctx = useContextMenu();
  const savingRef = useRef(false);
  // 이벤트 리스너가 매번 재구독되지 않도록 dirty를 ref로도 들고 있는다
  const dirtyRef = useRef(false);

  useSuppressNativeContextMenu();

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // 책은 `## 기록` 섹션만 편집한다 (메인 창의 책 화면과 같은 규칙)
  const isBook = note?.note_type === "book";
  const intro = useMemo(
    () => (isBook && note ? splitBookBody(note.body).intro : ""),
    [isBook, note],
  );

  useEffect(() => {
    commands.readNote(relPath).then((r) => {
      if (r.status === "ok") {
        setNote(r.data);
        setBody(
          r.data.note_type === "book"
            ? splitBookBody(r.data.body).records
            : r.data.body,
        );
      } else {
        setError(r.error);
      }
    });
  }, [relPath]);

  // 다른 창·외부 편집으로 파일이 바뀌면 따라간다.
  // 내가 편집 중(dirty)이면 건드리지 않는다 — 덮어쓰면 입력 중인 내용이 날아간다.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen<string[]>("vault-external-change", async (e) => {
      if (!e.payload.includes(relPath) || dirtyRef.current) return;
      const r = await commands.readNote(relPath);
      if (r.status !== "ok") return;
      const next =
        r.data.note_type === "book"
          ? splitBookBody(r.data.body).records
          : r.data.body;
      setNote(r.data);
      // 내용이 같으면 그대로 둔다 (내 저장이 되돌아온 메아리 · 커서 튐 방지)
      setBody((cur) => (cur === next ? cur : next));
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [relPath]);

  const save = useCallback(async () => {
    if (!note || savingRef.current) return;
    savingRef.current = true;
    try {
      const full = isBook ? composeBookBody(intro, body) : body;
      const r = await commands.saveNote(relPath, note.frontmatter, full);
      if (r.status === "ok") {
        setDirty(false);
        // 메인 창이 목록·검색을 갱신하도록 알린다 (외부변경 이벤트 재사용)
        await notifyOtherWindows([relPath]);
      } else {
        setError(r.error);
      }
    } finally {
      savingRef.current = false;
    }
  }, [note, body, intro, isBook, relPath]);

  /** 일지 빠른 입력 — 메인 창 스토어와 같은 3단계로 갱신 유실을 막는다.
   *  ① 내 편집분 먼저 저장 → ② 백엔드가 최신 파일에 추가 → ③ 결과로 로컬 상태 교체 */
  const appendDailyEntry = useCallback(
    async (kind: string, text: string) => {
      if (!note) return;
      if (dirtyRef.current) await save();
      const isBuiltin = kind === "todo" || kind === "log" || kind === "feeling";
      const r = isBuiltin
        ? await commands.appendDailyEntry(relPath, kind as DailyKind, text)
        : await commands.appendCallout(relPath, kind, text);
      if (r.status !== "ok") {
        setError(r.error);
        return;
      }
      // 일지는 책이 아니므로 본문 전체가 곧 편집 대상이다
      setNote(r.data);
      setBody(r.data.body);
      setDirty(false);
      await notifyOtherWindows([relPath]);
    },
    [note, save, relPath],
  );

  // 자동 저장 (3초 유휴) — 메인 창과 같은 감각으로
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(save, 3000);
    return () => clearTimeout(t);
  }, [dirty, body, save]);

  useShortcut("save", save);

  // 창을 닫을 때 저장하지 않은 내용을 흘리지 않는다
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWindow()
      .onCloseRequested(async (e) => {
        if (!dirty) return;
        e.preventDefault();
        try {
          await save();
        } finally {
          await getCurrentWindow().destroy();
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [dirty, save]);

  const title = relPath.split("/").pop()?.replace(/\.md$/, "") ?? "";

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-white p-6 text-center text-sm text-rose-500">
        {error}
      </div>
    );
  }
  if (!note) {
    return (
      <div className="flex h-screen items-center justify-center bg-white text-sm text-neutral-400">
        불러오는 중…
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-white text-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-2">
        <h1 className="truncate text-sm font-bold" title={title}>
          {title}
          {dirty && <span className="ml-1 text-amber-500">●</span>}
          {isBook && (
            <span className="ml-2 text-xs font-normal text-neutral-400">
              기록만 편집합니다
            </span>
          )}
        </h1>
        <div className="flex shrink-0 gap-2">
          <button
            className="rounded bg-neutral-800 px-3 py-1 text-xs text-white hover:bg-neutral-600 disabled:opacity-40"
            disabled={!dirty}
            onClick={save}
            title={`저장 (${shortcutTextOf("save")})`}
          >
            저장
          </button>
          <button
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-100"
            onClick={() => getCurrentWindow().close()}
          >
            닫기
          </button>
        </div>
      </header>

      {note.note_type === "daily" && (
        <DailyEntryBar onSubmit={appendDailyEntry} />
      )}

      <EditorToolbar view={editorView} />
      <div className="min-h-0 flex-1">
        <Editor
          onView={setEditorView}
          value={body}
          onChange={(v) => {
            setBody(v);
            setDirty(true);
          }}
          onContextMenu={(e, view) => ctx.open(e, editorMenuItems(view))}
        />
      </div>

      <div className="border-t border-neutral-100 px-4 py-1 text-right text-2xs text-neutral-400">
        {dirty ? "수정됨 · 잠시 후 자동 저장" : "저장됨"}
      </div>

      {ctx.menu && <ContextMenu state={ctx.menu} onClose={ctx.close} />}
    </div>
  );
}
