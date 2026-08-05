import { useEffect, useState } from "react";
import { commands } from "../../bindings";

/** 고급 — 노트 본문 템플릿 편집에서 다루는 내장 종류들 */
export const NOTE_TEMPLATE_KINDS: { id: string; label: string; placeholder: string }[] = [
  { id: "daily", label: "데일리노트", placeholder: "## 할 일\n\n- [ ] \n\n## 기록\n" },
  {
    id: "free",
    label: "자유노트",
    placeholder: "(기본은 빈 문서 — 원하는 템플릿을 넣어보세요)",
  },
  {
    id: "writing",
    label: "글쓰기",
    placeholder: "(기본은 빈 문서 — 원고를 바로 씁니다)",
  },
];

/** 라벨 + textarea + 저장 버튼 + 미리보기 — 본문 템플릿 편집이 공유하는 모양 */
export function TemplateEditor({
  label,
  value,
  placeholder,
  saved,
  onChange,
  onSave,
}: {
  label: string;
  value: string;
  placeholder?: string;
  saved: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-600">{label}</span>
        <span className="flex items-center gap-2">
          {saved && <span className="text-xs text-emerald-600">저장됨</span>}
          <button
            className="rounded border border-neutral-300 px-2 py-0.5 text-xs hover:border-neutral-500"
            onClick={onSave}
          >
            저장
          </button>
        </span>
      </div>
      <textarea
        className="h-24 w-full resize-y rounded border border-neutral-300 px-2 py-1 font-mono text-xs focus:border-neutral-500 focus:outline-none"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <TemplatePreview content={value} />
    </div>
  );
}

/** 템플릿 미리보기 — 화면에서 직접 치환하지 않고 백엔드를 거친다.
 *  노트를 실제로 만들 때와 같은 함수를 써야 미리보기가 거짓말을 하지 않는다. */
export function TemplatePreview({ content }: { content: string }) {
  const [out, setOut] = useState("");

  useEffect(() => {
    if (!content.trim()) {
      setOut("");
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      const r = await commands.previewTemplate(content, "");
      if (alive && r.status === "ok") setOut(r.data);
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [content]);

  if (!out) return null;
  return (
    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded border border-neutral-200 bg-neutral-50 px-2 py-1 text-2xs leading-relaxed text-neutral-600">
      {out}
    </pre>
  );
}
