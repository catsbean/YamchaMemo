import { useEffect, useState } from "react";
import { TemplateEditor } from "./TemplateEditor";

export default function CustomTypeRow({
  id,
  label,
  template,
  onRemoved,
  onTemplateSaved,
}: {
  id: string;
  label: string;
  template: string;
  onRemoved: () => Promise<void>;
  onTemplateSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(template);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);

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
