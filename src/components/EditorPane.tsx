import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { commands } from "../bindings";
import Editor from "../editor/Editor";
import BacklinksPanel from "./BacklinksPanel";
import BookView from "./BookView";
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
    externalChanged,
    reloadCurrent,
    dismissExternalChange,
  } = useVault();
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const goToLine = useRef<((line: number) => void) | null>(null);

  async function backToList() {
    if (dirty) await saveCurrent();
    closeNote();
  }

  // Ctrl+S 저장
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveCurrent();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveCurrent]);

  // 자동 저장: 마지막 수정 후 3초 유휴 시 (외부 변경 감지 시엔 덮어쓰기 방지)
  useEffect(() => {
    if (!dirty || externalChanged) return;
    const t = setTimeout(() => saveCurrent(), 3000);
    return () => clearTimeout(t);
  }, [dirty, externalChanged, current?.body, current?.frontmatter, saveCurrent]);

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

  async function commitRename() {
    const t = editingTitle?.trim();
    setEditingTitle(null);
    if (t && t !== displayTitle) await renameCurrent(t);
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
          {editingTitle !== null ? (
            <input
              autoFocus
              className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-0.5 text-base font-bold focus:border-neutral-500 focus:outline-none"
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
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
          <OutlineButton
            body={current.body}
            onJump={(line) => goToLine.current?.(line)}
          />
          <HistoryButton relPath={current.rel_path} />
          <button
            className="rounded bg-neutral-800 px-3 py-1 text-xs text-white hover:bg-neutral-600 disabled:opacity-40"
            disabled={!dirty}
            onClick={saveCurrent}
            title="저장 (Ctrl+S)"
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
      />

      <div className="min-h-0 flex-1">
        <Editor
          key={current.rel_path}
          value={current.body}
          onChange={setBody}
          onNavigate={openByTitle}
          onReady={(fn) => {
            goToLine.current = fn;
          }}
          getTitles={() =>
            notes
              .map(
                (n) =>
                  n.rel_path.split("/").pop()?.replace(/\.md$/, "") ?? n.title,
              )
              .filter(Boolean)
          }
        />
      </div>

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
    </div>
  );
}

/** 삭제 버튼: 클릭 → 강조 → 다시 클릭 → (확인 켜짐: 확인/취소 → 삭제, 꺼짐: 바로 삭제).
 *  실수 방지를 위해 최소 2번은 눌러야 하며, 4초간 가만두면 원래대로. */
function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const deleteConfirm = useVault((s) => s.deleteConfirm);
  const [stage, setStage] = useState(0);

  useEffect(() => {
    if (stage === 0) return;
    const t = setTimeout(() => setStage(0), 4000);
    return () => clearTimeout(t);
  }, [stage]);

  if (stage === 2) {
    return (
      <span className="flex gap-1">
        <button
          className="rounded bg-rose-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-rose-500"
          onClick={() => {
            setStage(0);
            onDelete();
          }}
        >
          삭제 확인
        </button>
        <button
          className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
          onClick={() => setStage(0)}
        >
          취소
        </button>
      </span>
    );
  }

  return (
    <button
      className={`rounded px-2 py-1 text-xs transition-colors ${
        stage === 1
          ? "bg-rose-100 font-bold text-rose-600 ring-1 ring-rose-300"
          : "text-rose-500 hover:bg-rose-50"
      }`}
      onClick={() => {
        if (stage === 0) {
          setStage(1);
        } else if (deleteConfirm) {
          setStage(2);
        } else {
          // 확인 단계 꺼짐: 두 번째 클릭에서 바로 삭제
          setStage(0);
          onDelete();
        }
      }}
    >
      {stage === 1 ? "삭제하시겠어요?" : "삭제"}
    </button>
  );
}

/** 하단 상태줄: 저장 상태 + 글자 수 (+ 글쓰기 목표 진행률) */
function StatusBar({
  body,
  dirty,
  goal,
}: {
  body: string;
  dirty: boolean;
  goal: number;
}) {
  const total = [...body].length;
  const noSpace = [...body].filter((c) => !/\s/.test(c)).length;
  const pct = goal > 0 ? Math.min(100, Math.round((noSpace / goal) * 100)) : 0;
  return (
    <div className="flex items-center justify-between border-t border-neutral-100 bg-white px-4 py-1 text-[11px] text-neutral-400">
      <span>{dirty ? "수정됨 · 잠시 후 자동 저장" : "저장됨"}</span>
      <span>
        {total.toLocaleString()}자 · 공백 제외 {noSpace.toLocaleString()}자
        {goal > 0 && (
          <span className={pct >= 100 ? "ml-1 text-emerald-500" : "ml-1"}>
            · 목표 {goal.toLocaleString()}자의 {pct}%
          </span>
        )}
      </span>
    </div>
  );
}
