import { useEffect, useState } from "react";
import { commands } from "../../bindings";
import { NOTE_TEMPLATE_KINDS, TemplateEditor } from "./TemplateEditor";
import TitlePrefixSection from "./TitlePrefixSection";

/** 고급 — 내장 노트 종류들의 본문 템플릿 편집 (frontmatter는 건드리지 않음) */
export default function NoteTemplateSection() {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    if (!open || loaded) return;
    (async () => {
      const next: Record<string, string> = {};
      for (const k of NOTE_TEMPLATE_KINDS) {
        const r = await commands.getNoteTemplate(k.id);
        next[k.id] = r.status === "ok" ? r.data : "";
      }
      setValues(next);
      setLoaded(true);
    })();
  }, [open, loaded]);

  async function save(kind: string) {
    const r = await commands.setNoteTemplate(kind, values[kind] ?? "");
    if (r.status === "ok") {
      setSaved(kind);
      setTimeout(() => setSaved(""), 2000);
    }
  }

  return (
    <section className="mb-5">
      <button
        className="text-sm font-semibold text-neutral-600 hover:text-neutral-800"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "▾" : "▸"} 고급 — 노트 템플릿
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-4">
          <div className="text-xs text-neutral-400">
            <p>
              새로 만드는 노트의 <b>본문</b> 템플릿입니다. frontmatter는
              건드리지 않으며, 비워 두면 기본값으로 돌아갑니다.
            </p>
            <p className="mt-1">
              쓸 수 있는 자리표시자:{" "}
              {[
                ["{{date}}", "2026-07-30"],
                ["{{weekday}}", "목"],
                ["{{yesterday}}", "어제"],
                ["{{tomorrow}}", "내일"],
                ["{{month}}", "2026-07"],
                ["{{year}}", "2026"],
                ["{{week}}", "31주"],
                ["{{time}}", "09:30"],
                ["{{title}}", "제목"],
              ].map(([k, v]) => (
                <code key={k} className="mr-1.5 whitespace-nowrap">
                  {k}
                  <span className="text-neutral-300">({v})</span>
                </code>
              ))}
            </p>
            <p className="mt-1">
              모르는 자리표시자는 그대로 남습니다 — 오타를 바로 알아챌 수 있게요.
            </p>
            <p className="mt-1">
              할 일 개수는 <b>내용이 있는</b> <code>- [ ]</code> 만 셉니다 —
              템플릿에 빈 체크박스를 넣어 두어도 숫자가 늘지 않습니다.
            </p>
          </div>
          {NOTE_TEMPLATE_KINDS.map((k) => (
            <TemplateEditor
              key={k.id}
              label={k.label}
              value={values[k.id] ?? ""}
              placeholder={k.placeholder}
              saved={saved === k.id}
              onChange={(v) => setValues((s) => ({ ...s, [k.id]: v }))}
              onSave={() => save(k.id)}
            />
          ))}

          <TitlePrefixSection />
        </div>
      )}
    </section>
  );
}
