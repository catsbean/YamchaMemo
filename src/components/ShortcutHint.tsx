import { IS_MAC, SHORTCUTS, shortcutText, useModKeyHeld } from "../lib/shortcuts";
import { useVault } from "../stores/vault";

/** Ctrl(⌘)을 누르고 있으면 화면 가운데 뜨는 단축키 안내.
 *
 *  메뉴 이동(1~9)은 여기 적지 않는다 — 사이드바 메뉴마다 자기 번호가 직접
 *  붙으므로, 여기서는 나머지 단축키만 보여 준다.
 *
 *  잠깐 스쳐 지나가는 조합(=단축키를 쓰려는 것)에는 안 뜨고, 좀 오래
 *  붙들고 있을 때만(=뭐가 있는지 찾는 중) 나타난다 — useModKeyHeld 참고. */
export default function ShortcutHint() {
  const held = useModKeyHeld();
  const shortcutsOff = useVault((s) => s.shortcutsOff);
  const items = SHORTCUTS.filter(
    (s) => s.mod && s.id !== "nav" && !shortcutsOff.includes(s.id),
  );
  const navOn = !shortcutsOff.includes("nav");
  const modName = IS_MAC ? "⌘" : "Ctrl";

  return (
    <div
      className={`pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/10 transition-opacity duration-150 ${
        held ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="max-h-[80%] overflow-y-auto rounded-xl border border-neutral-200 bg-white/95 px-6 py-5 shadow-2xl backdrop-blur-sm">
        <p className="mb-3 text-2xs font-medium tracking-wide text-neutral-400">
          단축키
        </p>
        <ul className="grid grid-cols-2 gap-x-8 gap-y-2">
          {items.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-4">
              <span className="text-sm text-neutral-700">{s.label}</span>
              <kbd className="shrink-0 rounded border border-neutral-300 bg-neutral-50 px-1.5 py-0.5 font-mono text-2xs text-neutral-600">
                {shortcutText(s)}
              </kbd>
            </li>
          ))}
        </ul>
        {navOn && (
          <p className="mt-4 border-t border-neutral-200 pt-3 text-2xs text-neutral-400">
            메뉴 이동은 왼쪽 메뉴에 붙은 번호를 {modName}와 함께 누르세요
          </p>
        )}
      </div>
    </div>
  );
}
