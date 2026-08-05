import { SHORTCUTS, shortcutText, useModKeyHeld } from "../lib/shortcuts";
import { useVault } from "../stores/vault";

/** Ctrl(⌘)을 누르고 있으면 사이드바 메뉴 위에 뜨는 단축키 목록.
 *  잠깐 스쳐 지나가는 조합(=단축키를 쓰려는 것)에는 안 뜨고, 좀 오래
 *  붙들고 있을 때만(=뭐가 있는지 찾는 중) 나타난다 — useModKeyHeld 참고. */
export default function ShortcutHint() {
  const held = useModKeyHeld();
  const shortcutsOff = useVault((s) => s.shortcutsOff);
  const items = SHORTCUTS.filter((s) => s.mod && !shortcutsOff.includes(s.id));

  return (
    <div
      className={`pointer-events-none absolute inset-x-2 top-14 bottom-14 z-40 overflow-y-auto rounded-lg border border-neutral-300 bg-white/95 p-3 shadow-lg backdrop-blur-sm transition-opacity duration-150 ${
        held ? "opacity-100" : "opacity-0"
      }`}
    >
      <p className="mb-2 text-2xs font-medium text-neutral-400">단축키</p>
      <ul className="flex flex-col gap-1.5">
        {items.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2">
            <span className="text-xs text-neutral-700">{s.label}</span>
            <kbd className="shrink-0 rounded border border-neutral-300 bg-neutral-50 px-1.5 py-0.5 font-mono text-2xs text-neutral-600">
              {shortcutText(s)}
            </kbd>
          </li>
        ))}
      </ul>
    </div>
  );
}
