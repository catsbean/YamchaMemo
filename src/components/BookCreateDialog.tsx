import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { load } from "@tauri-apps/plugin-store";
import { commands, type JsonValue } from "../bindings";
import { isImeEnter } from "../lib/ime";
import { useVault } from "../stores/vault";
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

/** 직접 입력 책 추가 — 검색과 동일 수준의 필드 + 표지(파일/붙여넣기) */
export default function BookCreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated?: (rel: string) => void;
}) {
  const { refresh, openNote } = useVault();
  const [f, setF] = useState({
    title: "",
    author: "",
    publisher: "",
    isbn: "",
    genre: "",
    status: "wishlist",
  });
  const [pendingCover, setPendingCover] = useState<
    { kind: "file"; path: string } | { kind: "paste"; b64: string; ext: string } | null
  >(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [autofillBusy, setAutofillBusy] = useState(false);
  const [autofillMsg, setAutofillMsg] = useState("");
  // 자동 채우기로 받은 표지 URL (파일/붙여넣기 표지가 없을 때만 사용)
  const [coverUrl, setCoverUrl] = useState("");

  useEffect(() => {
    load("settings.json", { autoSave: true, defaults: {} }).then(async (s) => {
      setApiKey((await s.get<string>("kakaoApiKey")) ?? "");
    });
  }, []);

  /** 카카오+교보로 빈 필드만 자동 채우기 */
  async function autofill() {
    if (autofillBusy || !f.title.trim()) return;
    setAutofillBusy(true);
    setAutofillMsg("");
    const r = await commands.autofillBook(f.title.trim(), f.author.trim(), apiKey);
    if (r.status === "ok") {
      const m = r.data;
      setF((cur) => ({
        ...cur,
        author: cur.author.trim() || m.author,
        publisher: cur.publisher.trim() || m.publisher,
        isbn: cur.isbn.trim() || m.isbn,
        genre: cur.genre.trim() || m.genre,
      }));
      if (!pendingCover && m.cover_url) {
        setCoverUrl(m.cover_url);
        setPreview(m.cover_url);
      }
      setAutofillMsg("불러왔습니다. 확인 후 추가하세요.");
    } else {
      setAutofillMsg(r.error);
    }
    setAutofillBusy(false);
  }

  async function pickCoverFile() {
    const src = await openDialog({
      title: "표지 이미지 선택",
      filters: [{ name: "이미지", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (typeof src === "string") {
      setPendingCover({ kind: "file", path: src });
      setPreview(convertFileSrc(src));
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
        setPreview(`data:${item.type};base64,${b64}`);
        e.preventDefault();
        return;
      }
    }
  }

  async function submit() {
    if (busy || !f.title.trim()) return;
    setBusy(true);
    setError("");
    try {
      const fields: { [k: string]: JsonValue } = { status: f.status };
      if (f.author.trim()) fields.author = f.author.trim();
      if (f.publisher.trim()) fields.publisher = f.publisher.trim();
      if (f.isbn.trim()) fields.isbn = f.isbn.trim();
      if (f.genre.trim()) fields.genre = f.genre.trim();
      const created = await commands.createNote("book", f.title.trim(), fields);
      if (created.status !== "ok") {
        setError(created.error);
        return;
      }
      const rel = created.data;
      if (pendingCover?.kind === "file") {
        await commands.attachCover(rel, pendingCover.path);
      } else if (pendingCover?.kind === "paste") {
        await commands.attachCoverPasted(rel, pendingCover.b64, pendingCover.ext);
      } else if (coverUrl) {
        await commands.attachCoverFromUrl(rel, coverUrl);
      }
      await refresh();
      if (onCreated) onCreated(rel);
      else await openNote(rel);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded border border-neutral-300 px-2 py-1 text-sm focus:border-neutral-500 focus:outline-none";

  return (
    <Modal onClose={onClose} panelClassName="w-[34rem] rounded-lg p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="text-base font-bold">책 직접 추가</h2>
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
          <div className="flex w-24 shrink-0 flex-col gap-2">
            <div
              className="flex aspect-[2/3] items-center justify-center overflow-hidden rounded-md bg-neutral-100"
              onPaste={onPaste}
              tabIndex={0}
              title="클릭 후 Ctrl+V로 표지 붙여넣기"
            >
              {preview ? (
                <img src={preview} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="px-1 text-center text-[10px] text-neutral-400">
                  표지
                </span>
              )}
            </div>
            <button
              className="rounded border border-neutral-300 py-1 text-xs hover:border-neutral-500"
              onClick={pickCoverFile}
            >
              파일 선택
            </button>
          </div>

          <div className="grid flex-1 grid-cols-2 gap-2">
            <label className="col-span-2 flex flex-col gap-0.5">
              <span className="text-xs text-neutral-500">제목 *</span>
              <input
                autoFocus
                className={inputCls}
                value={f.title}
                onChange={(e) => setF({ ...f, title: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && !isImeEnter(e) && submit()}
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
            <label className="col-span-2 flex flex-col gap-0.5">
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
          </div>
        </div>

        {error && <p className="mt-3 text-sm text-rose-500">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100"
            onClick={onClose}
          >
            취소
          </button>
          <button
            className="rounded bg-neutral-800 px-4 py-1.5 text-sm text-white hover:bg-neutral-600 disabled:opacity-50"
            disabled={busy || !f.title.trim()}
            onClick={submit}
          >
            {busy ? "추가 중…" : "추가"}
          </button>
        </div>
    </Modal>
  );
}
