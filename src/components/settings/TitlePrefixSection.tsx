import { useEffect, useState } from "react";
import { commands } from "../../bindings";
import {
  useVault,
} from "../../stores/vault";
import { isImeEnter } from "../../lib/ime";

/** 제목 머릿글 — 새 노트의 제목 앞에 자동으로 붙는 글 (예: "{{date}} ") */
export default function TitlePrefixSection() {
  const schemas = useVault((s) => s.schemas);
  // 파일명 규칙이 확고한 책·글쓰기·데일리는 대상이 아니다
  const targets = schemas.filter(
    (s) => !["book", "writing", "daily"].includes(s.id),
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    if (loaded || targets.length === 0) return;
    (async () => {
      const next: Record<string, string> = {};
      for (const t of targets) {
        const r = await commands.getTitleTemplate(t.id);
        next[t.id] = r.status === "ok" ? r.data : "";
      }
      setDrafts(next);
      setLoaded(true);
    })();
  }, [loaded, targets]);

  async function save(id: string) {
    const r = await commands.setTitleTemplate(id, drafts[id] ?? "");
    if (r.status === "ok") {
      setSaved(id);
      setTimeout(() => setSaved(""), 2000);
    }
  }

  if (targets.length === 0) return null;

  return (
    <div className="border-t border-neutral-100 pt-3">
      <p className="mb-1 text-xs font-medium text-neutral-600">제목 머릿글</p>
      <p className="mb-2 text-xs text-neutral-400">
        새 노트를 만들 때 제목 앞에 자동으로 붙는 글입니다. 예를 들어{" "}
        <code>{"{{date}} "}</code>를 넣으면 제목이{" "}
        <b>2026-07-27 회의록</b>처럼 만들어집니다. 끝의 공백도 그대로 쓰이니
        띄어쓰기를 잊지 마세요.
      </p>
      <div className="flex flex-col gap-1.5">
        {targets.map((t) => (
          <div key={t.id} className="flex items-center gap-2">
            <span className="w-20 shrink-0 truncate text-xs text-neutral-500">
              {t.label}
            </span>
            <input
              className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 font-mono text-xs focus:border-neutral-500 focus:outline-none"
              placeholder="(머릿글 없음)"
              value={drafts[t.id] ?? ""}
              onChange={(e) =>
                setDrafts((d) => ({ ...d, [t.id]: e.target.value }))
              }
              onKeyDown={(e) => e.key === "Enter" && !isImeEnter(e) && save(t.id)}
            />
            {saved === t.id && (
              <span className="shrink-0 text-xs text-emerald-600">저장됨</span>
            )}
            <button
              className="shrink-0 rounded border border-neutral-300 px-2 py-0.5 text-xs hover:border-neutral-500"
              onClick={() => save(t.id)}
            >
              저장
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
