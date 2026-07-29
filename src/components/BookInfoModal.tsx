import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { load } from "@tauri-apps/plugin-store";
import { commands, type JsonValue, type NoteContent } from "../bindings";
import { fmObject, useVault } from "../stores/vault";
import { composeBookBody } from "../lib/book";
import { coverSrc, fmStr } from "../lib/note";
import Modal from "./Modal";

const STATUSES: [string, string][] = [
  ["wishlist", "읽고 싶은 책"],
  ["reading", "읽는 중"],
  ["finished", "완독"],
  ["paused", "중단"],
];

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 책 정보(frontmatter) + 소개 + 표지 수정 모달 */
export default function BookInfoModal({
  note,
  intro,
  records,
  onClose,
}: {
  note: NoteContent;
  intro: string;
  records: string;
  onClose: () => void;
}) {
  const { vaultPath, refresh, openNote } = useVault();
  const fm0 = fmObject(note) as Record<string, unknown>;
  const [f, setF] = useState({
    title: fmStr(fm0, "title") || note.rel_path.split("/").pop()?.replace(/\.md$/, "") || "",
    author: fmStr(fm0, "author"),
    publisher: fmStr(fm0, "publisher"),
    isbn: fmStr(fm0, "isbn"),
    genre: fmStr(fm0, "genre"),
    status: fmStr(fm0, "status") || "wishlist",
    rating: fmStr(fm0, "rating"),
    started: fmStr(fm0, "started"),
    finished: fmStr(fm0, "finished"),
    cover: fmStr(fm0, "cover"),
  });
  const initialTags = Array.isArray((fm0 as { tags?: unknown }).tags)
    ? ((fm0 as { tags?: string[] }).tags ?? []).join(", ")
    : "";
  const [tagsDraft, setTagsDraft] = useState(initialTags);
  const [introDraft, setIntroDraft] = useState(intro);
  const [pendingCover, setPendingCover] = useState<
    { kind: "file"; path: string } | { kind: "paste"; b64: string; ext: string } | null
  >(null);
  const [pendingPreview, setPendingPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [autofillBusy, setAutofillBusy] = useState(false);
  const [autofillMsg, setAutofillMsg] = useState("");

  useEffect(() => {
    load("settings.json", { autoSave: true, defaults: {} }).then(async (s) => {
      setApiKey((await s.get<string>("kakaoApiKey")) ?? "");
    });
  }, []);

  /** 카카오+교보로 빈 필드만 자동 채우기 (제목, 있으면 저자 기준) */
  async function autofill() {
    if (autofillBusy || !f.title.trim()) return;
    setAutofillBusy(true);
    setAutofillMsg("");
    const r = await commands.autofillBook(f.title.trim(), f.author.trim(), apiKey);
    if (r.status === "ok") {
      const m = r.data;
      const rating = Number(m.rating) > 0 ? m.rating : "";
      setF((cur) => ({
        ...cur,
        author: cur.author.trim() || m.author,
        publisher: cur.publisher.trim() || m.publisher,
        isbn: cur.isbn.trim() || m.isbn,
        genre: cur.genre.trim() || m.genre,
        rating: cur.rating.trim() || rating,
        cover: cur.cover.trim() || m.cover_url,
      }));
      setIntroDraft((cur) => (cur.trim() ? cur : m.intro));
      setAutofillMsg("불러왔습니다. 확인 후 저장하세요.");
    } else {
      setAutofillMsg(r.error);
    }
    setAutofillBusy(false);
  }

  const coverUrl = pendingPreview ? pendingPreview : coverSrc(vaultPath, f.cover);

  async function pickCoverFile() {
    const src = await openDialog({
      title: "표지 이미지 선택",
      filters: [{ name: "이미지", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (typeof src === "string") {
      setPendingCover({ kind: "file", path: src });
      setPendingPreview(convertFileSrc(src));
    }
  }

  async function onPaste(e: React.ClipboardEvent) {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (!file) continue;
        const buf = await file.arrayBuffer();
        const ext = (item.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
        const b64 = bufToB64(buf);
        setPendingCover({ kind: "paste", b64, ext });
        setPendingPreview(`data:${item.type};base64,${b64}`);
        e.preventDefault();
        return;
      }
    }
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const rel = note.rel_path;
      let cover = f.cover;
      // 표지 첨부 먼저 (디스크에 저장 + fm.cover 갱신)
      if (pendingCover?.kind === "file") {
        const r = await commands.attachCover(rel, pendingCover.path);
        if (r.status === "ok") cover = r.data;
      } else if (pendingCover?.kind === "paste") {
        const r = await commands.attachCoverPasted(rel, pendingCover.b64, pendingCover.ext);
        if (r.status === "ok") cover = r.data;
      }

      // frontmatter 조립
      const patch: { [k: string]: JsonValue } = {
        author: f.author.trim() || null,
        publisher: f.publisher.trim() || null,
        isbn: f.isbn.trim() || null,
        genre: f.genre.trim() || null,
        status: f.status,
        rating: f.rating.trim() === "" ? null : Number(f.rating),
        started: f.started.trim() || null,
        finished: f.finished.trim() || null,
        cover: cover || null,
      };
      const cur = fmObject({ ...note, frontmatter: fm0 } as NoteContent) as {
        [k: string]: JsonValue;
      };
      const nextFm: { [k: string]: JsonValue } = { ...cur };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete nextFm[k];
        else nextFm[k] = v;
      }
      nextFm.tags = tagsDraft
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const body = composeBookBody(introDraft, records);
      await commands.saveNote(rel, nextFm, body);

      // 제목 변경 → 파일명·링크 갱신
      let finalRel = rel;
      const newTitle = f.title.trim();
      const oldTitle = fmStr(fm0, "title");
      if (newTitle && newTitle !== oldTitle) {
        const r = await commands.renameNote(rel, newTitle);
        if (r.status === "ok") finalRel = r.data;
      }

      await refresh();
      await openNote(finalRel);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded border border-neutral-300 px-2 py-1 text-sm focus:border-neutral-500 focus:outline-none";

  return (
    <Modal
      onClose={onClose}
      panelClassName="max-h-[88vh] w-[40rem] overflow-y-auto rounded-lg p-5 shadow-xl"
    >
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="text-base font-bold">책 정보 수정</h2>
          <div className="flex items-center gap-2">
            {autofillMsg && (
              <span className="text-xs text-neutral-500">{autofillMsg}</span>
            )}
            <button
              className="rounded border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-100 disabled:opacity-50"
              disabled={autofillBusy || !f.title.trim()}
              onClick={autofill}
              title="제목(있으면 저자)으로 카카오·교보에서 빈 항목을 채웁니다"
            >
              {autofillBusy ? "불러오는 중…" : "✨ 자동 채우기"}
            </button>
          </div>
        </div>

        <div className="flex gap-4">
          {/* 표지 */}
          <div className="flex w-28 shrink-0 flex-col gap-2">
            <div
              className="flex aspect-[2/3] items-center justify-center overflow-hidden rounded-md bg-neutral-100"
              onPaste={onPaste}
              tabIndex={0}
              title="여기를 클릭하고 이미지를 붙여넣기(Ctrl+V) 할 수 있습니다"
            >
              {coverUrl ? (
                <img src={coverUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="px-2 text-center text-3xs text-neutral-400">
                  표지 없음
                </span>
              )}
            </div>
            <button
              className="rounded border border-neutral-300 py-1 text-xs hover:border-neutral-500"
              onClick={pickCoverFile}
            >
              파일 선택
            </button>
            <p className="text-center text-3xs text-neutral-400">
              또는 위 칸에 Ctrl+V로 붙여넣기
            </p>
          </div>

          {/* 필드 */}
          <div className="grid flex-1 grid-cols-2 gap-2">
            <label className="col-span-2 flex flex-col gap-0.5">
              <span className="text-xs text-neutral-500">제목</span>
              <input
                className={inputCls}
                value={f.title}
                onChange={(e) => setF({ ...f, title: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-xs text-neutral-500">저자</span>
              <input
                className={inputCls}
                value={f.author}
                onChange={(e) => setF({ ...f, author: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-xs text-neutral-500">출판사</span>
              <input
                className={inputCls}
                value={f.publisher}
                onChange={(e) => setF({ ...f, publisher: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-xs text-neutral-500">분야</span>
              <input
                className={inputCls}
                value={f.genre}
                onChange={(e) => setF({ ...f, genre: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-xs text-neutral-500">ISBN</span>
              <input
                className={inputCls}
                value={f.isbn}
                onChange={(e) => setF({ ...f, isbn: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-xs text-neutral-500">상태</span>
              <select
                className={inputCls}
                value={f.status}
                onChange={(e) => setF({ ...f, status: e.target.value })}
              >
                {STATUSES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-xs text-neutral-500">평점 (0~5)</span>
              <input
                type="number"
                min={0}
                max={5}
                step={0.5}
                className={inputCls}
                value={f.rating}
                onChange={(e) => setF({ ...f, rating: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-xs text-neutral-500">읽기 시작</span>
              <input
                type="date"
                className={inputCls}
                value={f.started}
                onChange={(e) => setF({ ...f, started: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-xs text-neutral-500">완독일</span>
              <input
                type="date"
                className={inputCls}
                value={f.finished}
                onChange={(e) => setF({ ...f, finished: e.target.value })}
              />
            </label>
          </div>
        </div>

        <label className="mt-3 flex flex-col gap-0.5">
          <span className="text-xs text-neutral-500">태그 (쉼표로 구분)</span>
          <input
            className={inputCls}
            placeholder="예: 고전, 다시읽기"
            value={tagsDraft}
            onChange={(e) => setTagsDraft(e.target.value)}
          />
        </label>

        <label className="mt-3 flex flex-col gap-0.5">
          <span className="text-xs text-neutral-500">책 소개</span>
          <textarea
            className={`${inputCls} h-56 resize-y`}
            placeholder="책 소개나 메모를 적어보세요"
            value={introDraft}
            onChange={(e) => setIntroDraft(e.target.value)}
          />
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100"
            onClick={onClose}
          >
            취소
          </button>
          <button
            className="rounded bg-neutral-800 px-4 py-1.5 text-sm text-white hover:bg-neutral-600 disabled:opacity-50"
            disabled={busy}
            onClick={save}
          >
            {busy ? "저장 중…" : "저장"}
          </button>
        </div>
    </Modal>
  );
}
