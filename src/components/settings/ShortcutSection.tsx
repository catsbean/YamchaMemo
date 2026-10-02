import { useVault } from "../../stores/vault";
import { IS_MAC, SHORTCUTS, shortcutText } from "../../lib/shortcuts";
import Switch from "../Switch";
import { Section } from "./ui";

/** 단축키 목록 + 개별 켜고 끄기.
 *  키 조합을 바꾸는 기능은 아직 없다 — 목록 자체가 단축키 안내서 역할도 한다. */
export default function ShortcutSection() {
  const shortcutsOff = useVault((s) => s.shortcutsOff);
  const toggleShortcut = useVault((s) => s.toggleShortcut);

  return (
    <Section
      title="앱 단축키"
      desc={`${IS_MAC ? "맥에서는 ⌘" : "윈도우·리눅스에서는 Ctrl"}을 씁니다. 다른 앱과 겹치면 하나씩 끌 수 있습니다.`}
    >
      <ul className="flex flex-col gap-1">
        {SHORTCUTS.map((s) => {
          const on = !shortcutsOff.includes(s.id);
          return (
            <li
              key={s.id}
              className="flex items-center gap-2.5 rounded-md border border-neutral-200 px-3 py-1.5"
            >
              <kbd
                className={`shrink-0 rounded border px-2 py-0.5 font-mono text-xs ${
                  on
                    ? "border-neutral-300 bg-neutral-50 text-neutral-700"
                    : "border-neutral-200 bg-neutral-50 text-neutral-300 line-through"
                }`}
              >
                {shortcutText(s)}
              </kbd>
              <span className="min-w-0 flex-1 text-sm">
                <span className={on ? "" : "text-neutral-400"}>{s.label}</span>
                <span className="block text-2xs text-neutral-400">{s.hint}</span>
              </span>
              <Switch checked={on} onChange={() => toggleShortcut(s.id)} label={`${s.label} 단축키`} />
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
