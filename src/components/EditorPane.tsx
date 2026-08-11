import { useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { commands, type TagSuggestion } from "../bindings";
import type { EditorView } from "@codemirror/view";
import Editor from "../editor/Editor";
import EditorToolbar from "./EditorToolbar";
import { editorMenuItems, type UrlHit } from "../editor/editorMenu";
import { useContextMenu } from "../lib/contextMenu";
import { isImeEnter } from "../lib/ime";
import { shortcutTextOf, useShortcut } from "../lib/shortcuts";
import { linkOptions } from "../lib/resolveLink";
import { openNoteWindow } from "../lib/trashWindow";
import ContextMenu from "./ContextMenu";
import BacklinksPanel from "./BacklinksPanel";
import BookView from "./BookView";
import DailyEntryBar from "./DailyEntryBar";
import EntryList from "./EntryList";
import TodoList from "./TodoList";
import { DAILY_KINDS } from "../lib/callouts";
import DailyDateNav from "./DailyDateNav";
import ScrapModal from "./ScrapModal";
import DeleteButton from "./DeleteButton";
import MoveNoteButton from "./MoveNoteButton";
import ExportNoteButton from "./ExportNoteButton";
import { notifyOtherWindows } from "../lib/windowSync";
import DailyDigestBar from "./DailyDigestBar";
import FrontmatterForm from "./FrontmatterForm";
import { HistoryButton } from "./HistoryModal";
import OutlineButton from "./OutlineButton";
import { fmObject, useVault } from "../stores/vault";

export default function EditorPane() {
  const {
    current,
    dirty,
    schemas,
    notes,
    layout,
    setBody,
    setFrontmatter,
    saveCurrent,
    deleteCurrent,
    openByTitle,
    openNote,
    closeNote,
    refresh,
    renameCurrent,
    moveCurrent,
    externalChanged,
    reloadCurrent,
    dismissExternalChange,
    pendingTitleRel,
    clearPendingTitle,
    appendDaily,
    appendCalloutKind,
    todoPanel,
    setTodoPanel,
    todoBig,
    toggleTodoBig,
  } = useVault();
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const goToLine = useRef<((line: number) => void) | null>(null);
  // 제목 변경 단축키는 훅이라 조기 반환보다 위에 있어야 한다 — 값은 ref로 받는다
  const displayTitleRef = useRef<string | null>(null);
  const ctx = useContextMenu();
  const isDaily = current?.note_type === "daily";
  // 일지는 기본이 보기 모드(기록·할 일). [원문 편집]을 눌러야 생 마크다운이 나온다
  const [rawEdit, setRawEdit] = useState(false);
  // 서식 툴바가 명령을 실행하려면 CodeMirror 뷰가 필요하다
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  // 우클릭 "스크랩하기"로 누른 자리 — 있으면 팝업이 뜬다. 저장되면 이 범위를
  // [[스크랩 노트 제목]]으로 갈아끼운다(원래 URL/링크 자리를 vault 안 노트로 잇는다).
  const [scrapHit, setScrapHit] = useState<UrlHit | null>(null);
  // 자동 태그 제안 — 저장된 파일이 아니라 지금 편집 중인 초안을 본다
  const [tagSuggestions, setTagSuggestions] = useState<TagSuggestion[]>([]);

  /** 입력 바 제출 — 기본 종류는 enum 경로, 사용자 정의는 임의 라벨 콜아웃으로 */
  async function submitDaily(kind: string, text: string) {
    if (kind === "todo" || kind === "log" || kind === "feeling") {
      await appendDaily(kind, text);
    } else {
      await appendCalloutKind(kind, text);
    }
  }

  /** 보기 모드에서 항목을 고친 뒤: 파일에서 다시 읽고 다른 창에도 알린다 */
  async function onStructuredChange() {
    await reloadCurrent();
    if (current) await notifyOtherWindows([current.rel_path]);
  }

  /** 보기 ↔ 원문 편집 전환 (편집 중이던 내용은 흘리지 않고 저장한다) */
  async function toggleRawEdit() {
    if (rawEdit && dirty) await saveCurrent();
    setRawEdit((v) => !v);
  }

  async function backToList() {
    if (dirty) await saveCurrent();
    closeNote();
  }

  // 방금 만든 노트는 제목칸을 열어 둔다 (제목을 미리 묻지 않고 바로 만들었으므로)
  useEffect(() => {
    if (current && pendingTitleRel === current.rel_path) {
      setEditingTitle("");
    }
  }, [pendingTitleRel, current?.rel_path]);

  // 편집기 단축키 — 노트가 열려 있을 때만 (책은 BookView가 따로 그린다)
  useShortcut("save", saveCurrent, !!current);
  useShortcut("closeNote", backToList, !!current);
  useShortcut("rawEdit", toggleRawEdit, !!current && isDaily);
  useShortcut(
    "rename",
    () => setEditingTitle(displayTitleRef.current ?? ""),
    !!current && current?.note_type !== "daily",
  );

  // 자동 저장: 마지막 수정 후 3초 유휴 시 (외부 변경 감지 시엔 덮어쓰기 방지)
  useEffect(() => {
    if (!dirty || externalChanged) return;
    const t = setTimeout(() => saveCurrent(), 3000);
    return () => clearTimeout(t);
  }, [dirty, externalChanged, current?.body, current?.frontmatter, saveCurrent]);

  // 자동 태그 제안 — book은 BookView가 따로 다룬다. 타이핑이 멎고 500ms 뒤에만 묻는다.
  useEffect(() => {
    if (!current || current.note_type === "book") {
      setTagSuggestions([]);
      return;
    }
    const body = current.body;
    const fmNow = fmObject(current);
    const t = setTimeout(() => {
      const tags = Array.isArray(fmNow.tags)
        ? fmNow.tags.filter((v): v is string => typeof v === "string")
        : [];
      commands
        .suggestTagsForText({
          title: typeof fmNow.title === "string" ? fmNow.title : "",
          body,
          note_type: current.note_type,
          genre: typeof fmNow.genre === "string" ? fmNow.genre : null,
          current_tags: tags,
        })
        .then((r) => {
          if (r.status === "ok") setTagSuggestions(r.data);
        });
    }, 500);
    return () => clearTimeout(t);
    // rel은 노트가 바뀌었는지 판단하는 용도로만 쓴다 (참조 안정성 문제 회피)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.rel_path, current?.body, current?.frontmatter]);

  if (!current) {
    return (
      <div className="flex h-full flex-1 items-center justify-center text-sm text-neutral-400">
        노트를 선택하거나 새로 만들어 보세요
      </div>
    );
  }

  // 책은 독서기록 전용 뷰(정보 바 + 소개 + 기록)로 표시
  if (current.note_type === "book") {
    return <BookView note={current} />;
  }

  const schema = schemas.find((s) => s.id === current.note_type);
  const fm = fmObject(current);
  const fileName = current.rel_path.split("/").pop()?.replace(/\.md$/, "");
  // 데일리(날짜=이름)는 직접 변경 불가
  const canRename = current.note_type !== "daily";
  const displayTitle =
    typeof fm.title === "string" && fm.title.trim() ? fm.title : fileName;
  displayTitleRef.current = displayTitle ?? null;

  async function commitRename() {
    const t = editingTitle?.trim();
    setEditingTitle(null);
    if (!t) return; // 비워 두고 나가면 나중에 본문 첫머리로 자동 명명된다
    // 직접 이름을 지었으니 자동 명명 대상에서 뺀다
    clearPendingTitle();
    if (t !== displayTitle) await renameCurrent(t);
  }

  /** 제안 칩을 누르면 tags에 더한다 — 파일 저장은 기존 저장 흐름 그대로 */
  function addSuggestedTag(tag: string) {
    const tags = Array.isArray(fm.tags)
      ? fm.tags.filter((t): t is string => typeof t === "string")
      : [];
    if (tags.includes(tag)) return;
    setFrontmatter({ ...fm, tags: [...tags, tag] });
  }

  /** image 필드 [찾아보기]: 파일 선택 → 첨부 복사 → 값 갱신 */
  async function pickImage(fieldName: string) {
    const src = await openDialog({
      title: "이미지 선택",
      filters: [
        { name: "이미지", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
      ],
    });
    if (typeof src !== "string" || !current) return;
    if (current.note_type === "book" && fieldName === "cover") {
      // 표지 규칙: _attachments/covers/{책제목}.{ext} + frontmatter 자동 갱신
      const r = await commands.attachCover(current.rel_path, src);
      if (r.status === "ok") {
        await refresh();
        await openNote(current.rel_path);
      }
    } else {
      const r = await commands.importAttachment(src);
      if (r.status === "ok") {
        setFrontmatter({ ...fm, [fieldName]: r.data });
      }
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-2">
        <div className="flex items-baseline gap-2 overflow-hidden">
          {layout === "replace" && (
            <button
              className="shrink-0 rounded px-2 py-0.5 text-sm text-neutral-500 hover:bg-neutral-100"
              onClick={backToList}
              title="목록으로 (저장됨)"
            >
              ←
            </button>
          )}
          {isDaily ? (
            <DailyDateNav date={fileName ?? ""} />
          ) : editingTitle !== null ? (
            <input
              autoFocus
              className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-0.5 text-base font-bold focus:border-neutral-500 focus:outline-none"
              placeholder="제목 (비워 두면 본문 첫 줄로 정해집니다)"
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isImeEnter(e)) commitRename();
                if (e.key === "Escape") setEditingTitle(null);
              }}
            />
          ) : (
            <>
              <h1
                className={`truncate text-base font-bold ${canRename ? "cursor-text" : ""}`}
                onDoubleClick={() =>
                  canRename && setEditingTitle(displayTitle ?? "")
                }
                title={canRename ? "더블클릭으로 제목 변경" : undefined}
              >
                {fileName}
              </h1>
              {canRename && (
                <button
                  className="shrink-0 rounded px-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
                  onClick={() => setEditingTitle(displayTitle ?? "")}
                  title="제목 변경 (파일명과 링크가 함께 바뀝니다)"
                >
                  ✏️
                </button>
              )}
            </>
          )}
          <span className="shrink-0 text-xs text-neutral-400">
            {schema?.label}
            {dirty && <span className="ml-1 text-amber-500">●</span>}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isDaily && (
            <button
              className={`rounded border px-2 py-1 text-xs ${
                rawEdit
                  ? "border-neutral-800 bg-neutral-800 text-white hover:bg-neutral-600"
                  : "border-neutral-300 text-neutral-600 hover:border-neutral-500"
              }`}
              onClick={toggleRawEdit}
              title={
                rawEdit
                  ? "기록·할 일 보기로 돌아갑니다 (편집분은 저장됩니다)"
                  : "마크다운 원문을 직접 편집합니다"
              }
            >
              {rawEdit ? "보기" : "원문 편집"}
            </button>
          )}
          <OutlineButton
            body={current.body}
            onJump={(line) => goToLine.current?.(line)}
          />
          <button
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
            onClick={() => openNoteWindow(current!.rel_path)}
            title="새 창으로 열기 (목록에서 Ctrl+클릭)"
          >
            ⧉
          </button>
          <ExportNoteButton note={current} />
          <HistoryButton relPath={current.rel_path} />
          <MoveNoteButton
            schemas={schemas}
            currentTypeId={current.note_type}
            onMove={moveCurrent}
          />
          <button
            className="rounded bg-neutral-800 px-3 py-1 text-xs text-white hover:bg-neutral-600 disabled:opacity-40"
            disabled={!dirty}
            onClick={saveCurrent}
            title={`저장 (${shortcutTextOf("save")})`}
          >
            저장
          </button>
          <DeleteButton onDelete={deleteCurrent} />
          {layout !== "replace" && (
            <button
              className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-100"
              onClick={backToList}
              title="편집기 닫기 (저장됨)"
            >
              ✕
            </button>
          )}
        </div>
      </header>

      {externalChanged && (
        <div className="flex items-center justify-between bg-amber-50 px-4 py-2 text-sm text-amber-800">
          <span>
            ⚠️ 이 노트가 외부(다른 앱)에서 수정되었습니다. 지금 저장하면 외부
            수정이 덮어써집니다.
          </span>
          <span className="flex shrink-0 gap-2">
            <button
              className="rounded bg-amber-600 px-2.5 py-1 text-xs text-white hover:bg-amber-500"
              onClick={reloadCurrent}
            >
              다시 불러오기
            </button>
            <button
              className="rounded px-2 py-1 text-xs text-amber-600 hover:bg-amber-100"
              onClick={dismissExternalChange}
            >
              내 편집 유지
            </button>
          </span>
        </div>
      )}

      <FrontmatterForm
        schema={schema}
        value={fm}
        onChange={setFrontmatter}
        onPickImage={pickImage}
        tagSuggestions={tagSuggestions}
        onAddTag={addSuggestedTag}
        notes={notes}
      />

      {/* 일지 보기 모드: 입력 → 기록 → 할 일. 원문 편집으로 넘어가면 통째로 감춘다 */}
      {isDaily && !rawEdit && (
        <>
          <DailyEntryBar onSubmit={submitDaily} />

          {/* 할 일 자리: 아래(기본) 또는 오른쪽 — 설정에서 전환 */}
          <div
            className={`flex min-h-0 flex-1 ${
              todoPanel === "right" ? "flex-row" : "flex-col"
            }`}
          >
            <div className="min-h-0 flex-1 overflow-y-auto">
              <EntryList
                relPath={current.rel_path}
                body={current.body}
                onChanged={onStructuredChange}
                onOpenRaw={() => setRawEdit(true)}
                kinds={DAILY_KINDS}
              />
            </div>

            <div
              className={
                todoPanel === "right"
                  ? `${todoBig ? "w-[28rem]" : "w-[17rem]"} shrink-0 border-l border-neutral-200`
                  : `${todoBig ? "h-[65%]" : "h-[8rem]"} shrink-0`
              }
            >
              <TodoList
                relPath={current.rel_path}
                body={current.body}
                onChanged={onStructuredChange}
                showAddInput={false}
                kinds={DAILY_KINDS}
                big={todoBig}
                onToggleBig={toggleTodoBig}
                panel={todoPanel}
                onTogglePanel={() =>
                  setTodoPanel(todoPanel === "right" ? "bottom" : "right")
                }
              />
            </div>
          </div>
        </>
      )}

      {/* 원문 편집 (일지가 아니면 항상 이 화면) */}
      {(!isDaily || rawEdit) && (
        <>
        <EditorToolbar view={editorView} calloutKinds={isDaily ? DAILY_KINDS : []} />
        <div className="min-h-0 flex-1">
          <Editor
            onView={setEditorView}
            key={current.rel_path}
            value={current.body}
            onChange={setBody}
            onNavigate={openByTitle}
            onReady={(fn) => {
              goToLine.current = fn;
            }}
            onContextMenu={(e, view) =>
              ctx.open(
                e,
                editorMenuItems(view, isDaily ? DAILY_KINDS : [], {
                  event: e,
                  onNavigate: openByTitle,
                  onScrap: setScrapHit,
                }),
              )
            }
            getLinkOptions={() => linkOptions(notes, schemas)}
          />
        </div>
        </>
      )}

      {current.note_type === "daily" && (
        <DailyDigestBar date={typeof fm.date === "string" ? fm.date : ""} />
      )}

      <StatusBar
        body={current.body}
        dirty={dirty}
        goal={
          current.note_type === "writing" && typeof fm.goal === "number"
            ? fm.goal
            : 0
        }
      />
      <BacklinksPanel relPath={current.rel_path} />

      {ctx.menu && <ContextMenu state={ctx.menu} onClose={ctx.close} />}
      {scrapHit && (
        <ScrapModal
          url={scrapHit.url}
          onClose={() => setScrapHit(null)}
          onSaved={(stem) => {
            // 원래 URL/링크 자리를 방금 만든 노트로 잇는다
            editorView?.dispatch({
              changes: {
                from: scrapHit.from,
                to: scrapHit.to,
                insert: `[[${stem}]]`,
              },
            });
            setScrapHit(null);
          }}
        />
      )}
    </div>
  );
}

/** 하단 상태줄: 저장 상태 + 분량 (+ 글쓰기 목표 진행률) */
function StatusBar({
  body,
  dirty,
  goal,
}: {
  body: string;
  dirty: boolean;
  goal: number;
}) {
  const { words, withSpace, noSpace } = useMemo(() => {
    const chars = [...body];
    return {
      // 공백으로 끊어 센다 (한국어는 어절 수에 가깝다)
      words: body.trim() ? body.trim().split(/\s+/).length : 0,
      withSpace: chars.length,
      noSpace: chars.filter((c) => !/\s/.test(c)).length,
    };
  }, [body]);
  const pct = goal > 0 ? Math.min(100, Math.round((noSpace / goal) * 100)) : 0;

  return (
    <div className="flex items-center justify-between border-t border-neutral-100 bg-white px-4 py-1 text-2xs text-neutral-400">
      <span>{dirty ? "수정됨 · 잠시 후 자동 저장" : "저장됨"}</span>
      <span title="단어 수 · 공백 포함 글자수 · 공백 제외 글자수">
        {words.toLocaleString()}단어 · 공백 포함 {withSpace.toLocaleString()}자 ·
        공백 제외 {noSpace.toLocaleString()}자
        {goal > 0 && (
          <span className={pct >= 100 ? "ml-1 text-emerald-500" : "ml-1"}>
            · 목표 {goal.toLocaleString()}자의 {pct}%
          </span>
        )}
      </span>
    </div>
  );
}
