import { useEffect, useState } from "react";
import { load } from "@tauri-apps/plugin-store";
import { commands, type BookSearchHit } from "../bindings";
import { isImeEnter } from "../lib/ime";
import { useVault } from "../stores/vault";
import Modal from "./Modal";

/** 카카오 책 검색 → 선택하면 메타·표지까지 채워진 책 노트를 만든다 */
export default function BookSearchDialog({ onClose }: { onClose: () => void }) {
  const refresh = useVault((s) => s.refresh);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<BookSearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [addingIsbn, setAddingIsbn] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [added, setAdded] = useState<string[]>([]);

  useEffect(() => {
    load("settings.json", { autoSave: true, defaults: {} }).then(async (s) => {
      setApiKey((await s.get<string>("kakaoApiKey")) ?? "");
    });
  }, []);

  async function search() {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setError("");
    const r = await commands.searchBooks(q, apiKey ?? "");
    if (r.status === "ok") setHits(r.data);
    else setError(r.error);
    setBusy(false);
  }

  /** 책장에 추가 — 검색 결과의 기본 정보에 더해 분야·소개·평점까지 자동으로 채운다.
   *  (자동 채우기가 실패해도 책 자체는 만들어 둔다 — 나중에 [자동 채우기]로 보완 가능) */
  async function addBook(hit: BookSearchHit) {
    if (addingIsbn) return;
    setAddingIsbn(hit.isbn || hit.title);
    setError("");

    const fields: Record<string, string> = {};
    if (hit.authors) fields.author = hit.authors;
    if (hit.publisher) fields.publisher = hit.publisher;
    if (hit.isbn) fields.isbn = hit.isbn;

    // 분야·소개·평점은 교보에서 따로 가져온다 (검색 결과에는 없는 값)
    let intro = "";
    const meta = await commands.autofillBook(hit.title, hit.authors, apiKey ?? "");
    if (meta.status === "ok") {
      if (meta.data.genre) fields.genre = meta.data.genre;
      if (meta.data.rating) fields.rating = meta.data.rating;
      if (!fields.author && meta.data.author) fields.author = meta.data.author;
      if (!fields.publisher && meta.data.publisher)
        fields.publisher = meta.data.publisher;
      if (!fields.isbn && meta.data.isbn) fields.isbn = meta.data.isbn;
      intro = meta.data.intro;
    }

    const r = await commands.createNote("book", hit.title, fields);
    if (r.status !== "ok") {
      setError(r.error);
      setAddingIsbn(null);
      return;
    }

    // 소개는 본문 `## 소개` 섹션에 넣는다
    if (intro) {
      const cur = await commands.readNote(r.data);
      if (cur.status === "ok") {
        const body = `## 소개\n\n${intro}\n\n## 기록\n\n`;
        // 방금 만든 책에 소개를 채우는 자리다 — 충돌할 상대가 없다(null)
        await commands.saveNote(r.data, cur.data.frontmatter, body, null);
      }
    }
    if (hit.thumbnail_url) {
      await commands.attachCoverFromUrl(r.data, hit.thumbnail_url);
    }

    await refresh();
    setAdded((a) => [...a, hit.isbn || hit.title]);
    setAddingIsbn(null);
  }

  return (
    <Modal
      onClose={onClose}
      align="top"
      panelClassName="flex max-h-[75vh] w-[36rem] flex-col overflow-hidden rounded-xl shadow-2xl"
    >
        <div className="flex gap-2 border-b border-neutral-200 p-3">
          <input
            autoFocus
            className="min-w-0 flex-1 rounded border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none"
            placeholder="책 제목 또는 ISBN으로 검색 (카카오 책 검색)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeEnter(e)) search();
              if (e.key === "Escape") onClose();
            }}
          />
          <button
            className="shrink-0 rounded bg-neutral-800 px-4 py-2 text-sm text-white hover:bg-neutral-600 disabled:opacity-50"
            disabled={busy || !query.trim()}
            onClick={search}
          >
            {busy ? "검색 중…" : "검색"}
          </button>
        </div>

        {error && <p className="px-4 py-2 text-sm text-rose-500">{error}</p>}

        <ul className="flex-1 divide-y divide-neutral-100 overflow-y-auto">
          {hits.map((h) => {
            const key = h.isbn || h.title;
            const isAdded = added.includes(key);
            return (
              <li key={key} className="flex items-center gap-3 px-4 py-2.5">
                {h.thumbnail_url ? (
                  <img
                    src={h.thumbnail_url}
                    alt=""
                    className="h-16 w-11 shrink-0 rounded object-cover shadow"
                  />
                ) : (
                  <div className="h-16 w-11 shrink-0 rounded bg-neutral-100" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{h.title}</p>
                  <p className="truncate text-xs text-neutral-500">
                    {h.authors}
                    {h.publisher && ` · ${h.publisher}`}
                    {h.published && ` · ${h.published}`}
                  </p>
                </div>
                <button
                  className={`shrink-0 rounded px-3 py-1.5 text-xs ${
                    isAdded
                      ? "bg-emerald-50 text-emerald-600"
                      : "bg-neutral-800 text-white hover:bg-neutral-600"
                  } disabled:opacity-50`}
                  disabled={addingIsbn !== null || isAdded}
                  onClick={() => addBook(h)}
                >
                  {isAdded
                    ? "추가됨 ✓"
                    : addingIsbn === key
                      ? "채우는 중…"
                      : "책장에 추가"}
                </button>
              </li>
            );
          })}
          {hits.length === 0 && !busy && (
            <li className="px-4 py-8 text-center text-sm text-neutral-400">
              제목이나 ISBN을 검색해 추가하면 저자·출판사·표지에 더해
              분야·소개·평점까지 자동으로 채워집니다
            </li>
          )}
        </ul>

        <div className="border-t border-neutral-100 px-4 py-2 text-right">
          <button
            className="rounded px-3 py-1 text-sm text-neutral-500 hover:bg-neutral-100"
            onClick={onClose}
          >
            닫기
          </button>
        </div>
    </Modal>
  );
}
