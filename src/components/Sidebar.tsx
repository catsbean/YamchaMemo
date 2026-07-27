import { useState } from "react";
import { useVault } from "../stores/vault";
import CustomTypeDialog from "./CustomTypeDialog";
import SettingsModal from "./SettingsModal";

const BUILTIN_ICONS: Record<string, string> = {
  book: "📚",
  reading: "📖",
  writing: "✍️",
  daily: "📅",
  info: "🗂️",
  free: "📝",
};

/** 내비게이션 메뉴 — 내장 분류 / 구분선 / 사용자 추가 분류 / 설정 */
export default function Sidebar({ onSearch }: { onSearch: () => void }) {
  const { vaultPath, schemas, notes, nav, current, issues, setNav, openToday } =
    useVault();
  const [addingType, setAddingType] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const counts = new Map<string, number>();
  for (const n of notes) {
    counts.set(n.note_type, (counts.get(n.note_type) ?? 0) + 1);
  }
  counts.set("tags", new Set(notes.flatMap((n) => n.tags)).size);
  // 독서기록 = 전체 기록(발췌·생각·요약·질문) 개수
  counts.set(
    "reading",
    notes.reduce((s, n) => s + (n.note_type === "book" ? n.entry_count : 0), 0),
  );

  const builtins = schemas.filter((s) => s.builtin);
  const customs = schemas.filter((s) => !s.builtin);

  function MenuItem({ id, label, icon }: { id: string; label: string; icon: string }) {
    const active = nav === id && !current;
    return (
      <button
        className={`mb-1 flex w-full items-center justify-between rounded-md px-3 py-2 text-sm ${
          active
            ? "bg-neutral-800 text-white"
            : nav === id
              ? "bg-neutral-200 text-neutral-800"
              : "text-neutral-700 hover:bg-neutral-200"
        }`}
        onClick={() => setNav(id)}
      >
        <span>
          <span className="mr-2">{icon}</span>
          {label}
        </span>
        {counts.has(id) && (
          <span
            className={`text-xs ${active ? "text-neutral-300" : "text-neutral-400"}`}
          >
            {counts.get(id)}
          </span>
        )}
      </button>
    );
  }

  return (
    <aside className="flex h-full w-52 shrink-0 flex-col border-r border-neutral-200 bg-neutral-100">
      <div className="flex items-center justify-between px-3 py-3">
        <span className="text-sm font-bold">YamchaMemo</span>
        <button
          className="rounded bg-neutral-800 px-2 py-1 text-xs text-white hover:bg-neutral-600"
          onClick={openToday}
          title="오늘의 데일리노트 열기"
        >
          오늘
        </button>
      </div>

      <div className="px-2 pb-2">
        <button
          className="flex w-full items-center justify-between rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-400 hover:border-neutral-400"
          onClick={onSearch}
        >
          <span>🔍 검색</span>
          <kbd className="text-[10px]">Ctrl K</kbd>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2">
        <MenuItem id="home" label="홈" icon="🏠" />
        {builtins.map((s) => (
          <span key={s.id}>
            <MenuItem
              id={s.id}
              label={s.label}
              icon={BUILTIN_ICONS[s.id] ?? "📄"}
            />
            {/* 도서리스트 바로 아래에 독서기록(가상 메뉴) 배치 */}
            {s.id === "book" && (
              <MenuItem id="reading" label="독서기록" icon="📖" />
            )}
          </span>
        ))}
        <MenuItem id="tags" label="태그" icon="🏷️" />

        <div className="my-2 border-t border-neutral-200" />
        <p className="mb-1 px-3 text-[11px] text-neutral-400">사용자 추가 분류</p>
        {customs.map((s) => (
          <MenuItem key={s.id} id={s.id} label={s.label} icon="📁" />
        ))}
        <button
          className="mb-1 w-full rounded-md border border-dashed border-neutral-300 px-3 py-1.5 text-left text-sm text-neutral-400 hover:border-neutral-400 hover:text-neutral-600"
          onClick={() => setAddingType(true)}
        >
          + 분류 추가
        </button>
      </nav>

      <div className="border-t border-neutral-200 px-3 py-2">
        {issues.length > 0 && (
          <button
            className={`mb-2 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs ${
              nav === "audit"
                ? "bg-rose-600 text-white"
                : "bg-rose-50 text-rose-600 hover:bg-rose-100"
            }`}
            onClick={() => setNav("audit")}
            title="규격에서 벗어나 목록에 안 보이는 노트가 있습니다"
          >
            <span>⚠️ 점검</span>
            <span className="font-bold">{issues.length}</span>
          </button>
        )}
        <p className="truncate text-[11px] text-neutral-400" title={vaultPath ?? ""}>
          {vaultPath}
        </p>
        <button
          className="mt-1 text-[11px] text-neutral-500 underline hover:text-neutral-700"
          onClick={() => setSettingsOpen(true)}
        >
          ⚙️ 설정
        </button>
      </div>

      {addingType && <CustomTypeDialog onClose={() => setAddingType(false)} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </aside>
  );
}
