import { useMemo, useState } from "react";
import type { NoteContent, NoteSummary } from "../bindings";
import { fmObject, useVault } from "../stores/vault";
import { splitBookBody } from "../lib/book";
import {
  BOOK_STATUS_LABELS as STATUS_LABELS,
  coverSrc,
  fmStr,
} from "../lib/note";
import Editor from "../editor/Editor";
import { editorMenuItems } from "../editor/editorMenu";
import { useContextMenu } from "../lib/contextMenu";
import { shortcutTextOf, useShortcut } from "../lib/shortcuts";
import ContextMenu from "./ContextMenu";
import BacklinksPanel from "./BacklinksPanel";
import BookInfoModal from "./BookInfoModal";
import { HistoryButton } from "./HistoryModal";
import ReadingEntryBar from "./ReadingEntryBar";
import DeleteButton from "./DeleteButton";
import EntryList from "./EntryList";
import { BOOK_KINDS } from "../lib/callouts";
import { notifyOtherWindows } from "../lib/windowSync";

/** 책 = 독서기록. 정보 바 + 접힌 소개 + 기록 입력 + 기록 편집기 */
export default function BookView({ note }: { note: NoteContent }) {
  const {
    vaultPath,
    notes,
    dirty,
    setBody,
    saveCurrent,
    deleteCurrent,
    openByTitle,
    closeNote,
    layout,
    updateFrontmatter,
    openNote,
    reloadCurrent,
  } = useVault();
  const [showIntro, setShowIntro] = useState(false);
  const [editing, setEditing] = useState(false);
  // 기본은 기록 카드 보기 — [원문 편집]을 눌러야 생 마크다운이 나온다
  const [rawEdit, setRawEdit] = useState(false);

  useShortcut("rawEdit", () => toggleRawEdit());

  async function toggleRawEdit() {
    if (rawEdit && dirty) await saveCurrent();
    setRawEdit((v) => !v);
  }
  const ctx = useContextMenu();

  const fm = fmObject(note) as Record<string, unknown>;
  const { intro, records } = useMemo(() => splitBookBody(note.body), [note.body]);
  const title = fmStr(fm, "title") || note.rel_path.split("/").pop()?.replace(/\.md$/, "");
  const author = fmStr(fm, "author");
  const genre = fmStr(fm, "genre");
  const status = fmStr(fm, "status");
  const rating = fmStr(fm, "rating");
  const cover = fmStr(fm, "cover");
  const coverUrl = coverSrc(vaultPath, cover);
  const tags = note.frontmatter && typeof note.frontmatter === "object" && !Array.isArray(note.frontmatter)
    ? ((note.frontmatter as Record<string, unknown>).tags as string[] | undefined) ?? []
    : [];

  function onRecordsChange(newRecords: string) {
    const { intro: curIntro } = splitBookBody(note.body);
    // composeBookBody 유지: 소개는 그대로, 기록만 교체
    import("../lib/book").then(({ composeBookBody }) => {
      setBody(composeBookBody(curIntro, newRecords));
    });
  }

  async function backToList() {
    if (dirty) await saveCurrent();
    closeNote();
  }

  /** 정보 바 인라인 편집: 기록 편집이 있으면 먼저 저장 → frontmatter 패치 → 현재 노트 리로드 */
  async function patchInfo(patch: Record<string, string | number | string[] | null>) {
    if (dirty) await saveCurrent();
    await updateFrontmatter(note.rel_path, patch);
    await openNote(note.rel_path);
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* 헤더 */}
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
          <h1 className="truncate text-base font-bold">{title}</h1>
          <span className="shrink-0 text-xs text-neutral-400">
            독서기록
            {dirty && <span className="ml-1 text-amber-500">●</span>}
          </span>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            className="rounded bg-neutral-700 px-3 py-1 text-xs text-white hover:bg-neutral-500"
            onClick={() => setEditing(true)}
            title="책 정보와 소개를 수정합니다"
          >
            정보 수정
          </button>
          <button
            className={`rounded border px-2 py-1 text-xs ${
              rawEdit
                ? "border-neutral-800 bg-neutral-800 text-white hover:bg-neutral-600"
                : "border-neutral-300 text-neutral-600 hover:border-neutral-500"
            }`}
            onClick={toggleRawEdit}
            title={
              rawEdit
                ? "기록 보기로 돌아갑니다 (편집분은 저장됩니다)"
                : "기록 원문을 직접 편집합니다"
            }
          >
            {rawEdit ? "보기" : "원문 편집"}
          </button>
          <HistoryButton relPath={note.rel_path} />
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
            >
              ✕
            </button>
          )}
        </div>
      </header>

      {/* 책 정보 바 (인라인 편집) */}
      <div className="flex items-start gap-3 border-b border-neutral-200 bg-neutral-50 px-4 py-2">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt=""
            className="h-16 w-11 shrink-0 rounded object-cover shadow"
          />
        ) : (
          <div className="flex h-16 w-11 shrink-0 items-center justify-center rounded bg-neutral-200 text-lg">
            📚
          </div>
        )}
        <div className="min-w-0 flex-1 text-xs text-neutral-500">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {author && <span>✍️ {author}</span>}
            {genre && <span>🏷️ {genre}</span>}
            <select
              className="rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-neutral-600 hover:border-neutral-400 focus:border-neutral-500 focus:outline-none"
              value={status || "wishlist"}
              onChange={(e) => patchInfo({ status: e.target.value })}
              title="읽기 상태"
            >
              {Object.entries(STATUS_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <StarRating
              value={rating ? Number(rating) : 0}
              onChange={(v) => patchInfo({ rating: v })}
            />
            <label className="flex items-center gap-1">
              <span className="text-neutral-400">시작</span>
              <input
                type="date"
                className="rounded border border-neutral-200 bg-white px-1 py-0.5 text-neutral-600 hover:border-neutral-400 focus:border-neutral-500 focus:outline-none"
                value={fmStr(fm, "started")}
                onChange={(e) => patchInfo({ started: e.target.value || null })}
              />
            </label>
            <label className="flex items-center gap-1">
              <span className="text-neutral-400">완독</span>
              <input
                type="date"
                className="rounded border border-neutral-200 bg-white px-1 py-0.5 text-neutral-600 hover:border-neutral-400 focus:border-neutral-500 focus:outline-none"
                value={fmStr(fm, "finished")}
                onChange={(e) => patchInfo({ finished: e.target.value || null })}
              />
            </label>
          </div>
          <TagEditor
            tags={tags}
            onCommit={(next) => patchInfo({ tags: next })}
          />
        </div>
      </div>

      {/* 접힌 소개 */}
      <div className="border-b border-neutral-200">
        <button
          className="flex w-full items-center gap-1 px-4 py-1.5 text-left text-xs font-medium text-neutral-500 hover:bg-neutral-50"
          onClick={() => setShowIntro((v) => !v)}
        >
          <span className="inline-block w-3">{showIntro ? "▾" : "▸"}</span>
          책 소개
          {!intro && <span className="text-neutral-300">(비어 있음)</span>}
        </button>
        {showIntro && (
          <div className="max-h-48 overflow-y-auto whitespace-pre-wrap px-6 pb-3 text-sm text-neutral-600">
            {intro || (
              <span className="text-neutral-400">
                [정보 수정]에서 책 소개를 적을 수 있습니다.
              </span>
            )}
          </div>
        )}
      </div>

      {/* 기록 입력 */}
      <ReadingEntryBar />

      {/* 기록 항목별 수정·삭제 (보기 모드) */}
      {!rawEdit && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <EntryList
            relPath={note.rel_path}
            body={note.body}
            onChanged={async () => {
              await reloadCurrent();
              await notifyOtherWindows([note.rel_path]);
            }}
            onOpenRaw={() => setRawEdit(true)}
            kinds={BOOK_KINDS}
          />
        </div>
      )}

      {/* 기록 원문 편집 */}
      {rawEdit && (
      <div className="min-h-0 flex-1">
        <Editor
          key={note.rel_path}
          value={records}
          onChange={onRecordsChange}
          onNavigate={openByTitle}
          getTitles={() =>
            notes
              .map((n: NoteSummary) => n.rel_path.split("/").pop()?.replace(/\.md$/, "") ?? n.title)
              .filter(Boolean)
          }
          onContextMenu={(e, view) =>
            ctx.open(
              e,
              editorMenuItems(view, BOOK_KINDS, {
                event: e,
                onNavigate: openByTitle,
              }),
            )
          }
        />
      </div>
      )}

      <BacklinksPanel relPath={note.rel_path} />

      {editing && (
        <BookInfoModal note={note} intro={intro} records={records} onClose={() => setEditing(false)} />
      )}
      {ctx.menu && <ContextMenu state={ctx.menu} onClose={ctx.close} />}
    </div>
  );
}

/** 별점: N번째 별을 다시 누르면 N ↔ N-0.5 순환, 다른 별을 누르면 그 별로 리셋 */
function StarRating({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number | null) => void;
}) {
  return (
    <span className="inline-flex items-center gap-0.5" title="별점">
      {[1, 2, 3, 4, 5].map((n) => {
        const fill = value >= n ? 1 : value >= n - 0.5 ? 0.5 : 0;
        return (
          <button
            key={n}
            className="relative text-sm leading-none"
            onClick={() => onChange(value === n ? n - 0.5 : n)}
            title={`${n}점 (다시 누르면 ${n - 0.5}점)`}
          >
            <span className="text-neutral-300">★</span>
            <span
              className="absolute inset-0 overflow-hidden text-amber-400"
              style={{ width: `${fill * 100}%` }}
            >
              ★
            </span>
          </button>
        );
      })}
      {value > 0 && (
        <button
          className="ml-0.5 text-[10px] text-neutral-400 hover:text-neutral-600"
          onClick={() => onChange(null)}
          title="별점 지우기"
        >
          ×
        </button>
      )}
    </span>
  );
}

/** 태그 인라인 편집: 쉼표 구분 문자열 → 배열, blur/Enter 시 커밋 */
function TagEditor({
  tags,
  onCommit,
}: {
  tags: string[];
  onCommit: (next: string[]) => void;
}) {
  const joined = tags.join(", ");
  const [v, setV] = useState(joined);
  const [prev, setPrev] = useState(joined);
  if (joined !== prev) {
    setPrev(joined);
    setV(joined);
  }
  function commit() {
    const next = v
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (next.join(",") !== tags.join(",")) onCommit(next);
  }
  return (
    <div className="mt-1 flex items-center gap-1">
      <span className="text-neutral-400">#</span>
      <input
        className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-[11px] text-violet-600 placeholder-neutral-300 hover:border-neutral-200 focus:border-neutral-400 focus:bg-white focus:outline-none"
        placeholder="태그 (쉼표로 구분)"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}

