import { useEffect, useState } from "react";
import type { FieldDef } from "../../bindings";
import { TemplateEditor } from "./TemplateEditor";

/** 목록 줄이 이미 보여 주는 칸 — 켜고 끌 것이 없으므로 아예 내놓지 않는다 */
const ALWAYS_SHOWN = ["date", "tags"];

export default function CustomTypeRow({
  id,
  label,
  fields,
  template,
  onRemoved,
  onTemplateSaved,
}: {
  id: string;
  label: string;
  /** 이 분류의 frontmatter 칸들 (목록에 내보일 칸을 여기서 고른다) */
  fields: FieldDef[];
  template: string;
  onRemoved: () => Promise<void>;
  onTemplateSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(template);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const choosable = fields.filter((f) => !ALWAYS_SHOWN.includes(f.name));

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  async function remove() {
    setBusy(true);
    const { commands } = await import("../../bindings");
    await commands.removeCustomType(id);
    await onRemoved();
    setBusy(false);
  }

  /** 칸 하나를 켜고 끈다 — 켜진 칸 전부를 다시 보낸다(백엔드가 목록 그대로 맞춘다) */
  async function toggleField(name: string, on: boolean) {
    setBusy(true);
    const next = fields
      .filter((f) => (f.name === name ? on : f.in_list))
      .map((f) => f.name);
    const { commands } = await import("../../bindings");
    const r = await commands.updateCustomTypeListFields(id, next);
    if (r.status === "ok") await onTemplateSaved();
    setBusy(false);
  }

  async function save() {
    setBusy(true);
    const { commands } = await import("../../bindings");
    const r = await commands.updateCustomTypeTemplate(id, draft);
    if (r.status === "ok") {
      await onTemplateSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
    setBusy(false);
  }

  return (
    <li className="rounded border border-neutral-200 px-3 py-2 text-sm">
      <div className="mb-1.5 flex items-center justify-between">
        <span>📁 {label}</span>
        {confirming ? (
          <span className="flex items-center gap-1">
            <span className="text-2xs text-neutral-400">
              노트는 자유노트로 이동
            </span>
            <button
              className="rounded bg-rose-600 px-2 py-0.5 text-xs font-bold text-white hover:bg-rose-500 disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                remove();
              }}
            >
              제거 확인
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100"
              onClick={() => setConfirming(false)}
            >
              취소
            </button>
          </span>
        ) : (
          <button
            className="text-xs text-rose-400 hover:text-rose-600 disabled:opacity-50"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            제거
          </button>
        )}
      </div>
      {choosable.length > 0 && (
        <div className="mb-1.5">
          <span className="text-2xs text-neutral-400">
            목록에 함께 보일 칸
          </span>
          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1">
            {choosable.map((f) => (
              <label
                key={f.name}
                className="flex items-center gap-1 text-xs text-neutral-600"
              >
                <input
                  type="checkbox"
                  checked={f.in_list}
                  disabled={busy}
                  onChange={(e) => toggleField(f.name, e.target.checked)}
                />
                {f.label || f.name}
              </label>
            ))}
          </div>
        </div>
      )}
      <TemplateEditor
        label="본문 템플릿"
        value={draft}
        saved={saved}
        onChange={setDraft}
        onSave={save}
      />
    </li>
  );
}
