import { useMemo, useState } from "react";
import { useVault } from "../stores/vault";
import { coverSrc, fmStr } from "../lib/note";
import BookCreateDialog from "./BookCreateDialog";
import BookSearchDialog from "./BookSearchDialog";
import Modal from "./Modal";

/** 독서기록 새로만들기 → 책 선택 팝업 (그리드/리스트, 설정으로 전환) */
export default function BookPickerDialog({ onClose }: { onClose: () => void }) {
  const { notes, vaultPath, openNote, bookPickerView, setBookPickerView } =
    useVault();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [searching, setSearching] = useState(false);

  const books = useMemo(() => {
    const list = notes.filter((n) => n.note_type === "book");
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (b) =>
        b.title.toLowerCase().includes(q) ||
        fmStr(b, "author").toLowerCase().includes(q),
    );
  }, [notes, query]);

  function pick(rel: string) {
    openNote(rel);
    onClose();
  }

  return (
    <>
      <Modal
        onClose={onClose}
        align="top"
        panelClassName="flex max-h-[75vh] w-[40rem] flex-col overflow-hidden rounded-xl shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-neutral-200 p-3">
          <input
            autoFocus
            className="min-w-0 flex-1 rounded border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-500 focus:outline-none"
            placeholder="기록할 책 선택 — 제목·저자 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="flex shrink-0 items-center gap-1 text-xs">
            <button
              className={`rounded px-2 py-1 ${bookPickerView === "grid" ? "bg-neutral-200" : "text-neutral-400 hover:bg-neutral-100"}`}
              onClick={() => setBookPickerView("grid")}
              title="책장 보기"
            >
              ▦
            </button>
            <button
              className={`rounded px-2 py-1 ${bookPickerView === "list" ? "bg-neutral-200" : "text-neutral-400 hover:bg-neutral-100"}`}
              onClick={() => setBookPickerView("list")}
              title="목록 보기"
            >
              ☰
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {books.length === 0 && (
            <p className="py-8 text-center text-sm text-neutral-400">
              책이 없습니다. 아래에서 새 책을 추가하세요.
            </p>
          )}
          {bookPickerView === "grid" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-3">
              {books.map((b) => {
                const url = coverSrc(vaultPath, fmStr(b, "cover"));
                return (
                  <button
                    key={b.rel_path}
                    className="group flex flex-col gap-1"
                    onClick={() => pick(b.rel_path)}
                  >
                    <div className="aspect-[2/3] overflow-hidden rounded shadow transition-transform group-hover:-translate-y-1 group-hover:shadow-md">
                      {url ? (
                        <img src={url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-neutral-100 p-1 text-center text-3xs text-neutral-500">
                          {b.title}
                        </div>
                      )}
                    </div>
                    <span className="line-clamp-2 text-2xs text-neutral-600">
                      {b.title}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {books.map((b) => (
                <li key={b.rel_path}>
                  <button
                    className="flex w-full items-center gap-3 px-2 py-2 text-left hover:bg-neutral-50"
                    onClick={() => pick(b.rel_path)}
                  >
                    <span className="truncate text-sm font-medium">{b.title}</span>
                    {fmStr(b, "author") && (
                      <span className="shrink-0 text-xs text-neutral-400">
                        {fmStr(b, "author")}
                      </span>
                    )}
                    {b.entry_count > 0 && (
                      <span className="ml-auto shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-2xs text-amber-600">
                        기록 {b.entry_count}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-between border-t border-neutral-100 px-3 py-2">
          <div className="flex gap-2">
            <button
              className="rounded bg-amber-600 px-3 py-1 text-xs text-white hover:bg-amber-500"
              onClick={() => setSearching(true)}
            >
              🔍 검색해서 추가
            </button>
            <button
              className="rounded bg-neutral-800 px-3 py-1 text-xs text-white hover:bg-neutral-600"
              onClick={() => setAdding(true)}
            >
              + 직접 입력
            </button>
          </div>
          <button
            className="rounded px-3 py-1 text-sm text-neutral-500 hover:bg-neutral-100"
            onClick={onClose}
          >
            닫기
          </button>
        </div>
      </Modal>

      {adding && (
        <BookCreateDialog
          onClose={() => setAdding(false)}
          onCreated={(rel) => {
            setAdding(false);
            pick(rel);
          }}
        />
      )}
      {searching && <BookSearchDialog onClose={() => setSearching(false)} />}
    </>
  );
}
