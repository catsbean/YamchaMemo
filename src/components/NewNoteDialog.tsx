import { useMemo, useState } from "react";
import type { FieldDef, JsonValue } from "../bindings";
import { isImeEnter } from "../lib/ime";
import { useVault } from "../stores/vault";
import Modal from "./Modal";

interface Props {
  noteType: string;
  onClose: () => void;
}

/** 시리즈의 다음 회차 번호 (frontmatter episode 우선, 제목의 NNNN편 보조) */
export function nextEpisodeNumber(
  notes: { note_type: string; title: string; frontmatter: unknown }[],
  series: string,
): number {
  let max = 0;
  for (const n of notes) {
    if (n.note_type !== "writing") continue;
    const fm = n.frontmatter as Record<string, unknown> | null;
    if (!fm || typeof fm !== "object" || fm.series !== series) continue;
    let ep = typeof fm.episode === "number" ? fm.episode : 0;
    if (!ep) {
      const m = n.title.match(/(\d{1,4})\s*편/);
      if (m) ep = Number(m[1]);
    }
    if (ep > max) max = ep;
  }
  return max + 1;
}

/** 생성 시 입력받을 필드 선별 (공통 필드 제외, 입력 가능한 종류만) */
function creationFields(noteType: string, fields: FieldDef[]): FieldDef[] {
  const skip = new Set(["date", "tags", "title"]);
  if (noteType === "book") {
    return fields.filter((f) => ["author", "genre"].includes(f.name));
  }
  if (noteType === "reading") {
    return fields.filter((f) => ["author"].includes(f.name));
  }
  if (noteType === "info") {
    return fields.filter((f) => ["source"].includes(f.name));
  }
  // writing은 전용 UI 사용
  if (noteType === "writing" || noteType === "free" || noteType === "daily") {
    return [];
  }
  // 사용자 정의 타입: 텍스트 계열 필드를 생성 폼에 노출
  return fields.filter(
    (f) =>
      !skip.has(f.name) &&
      ["text", "select", "url", "wikilink"].includes(f.kind),
  );
}

/** 타입별 생성 폼: 파일명/frontmatter 초기값에 필요한 최소 필드만 받는다 */
export default function NewNoteDialog({ noteType, onClose }: Props) {
  const { schemas, notes, createNote, openToday } = useVault();
  const schema = schemas.find((s) => s.id === noteType);
  const [title, setTitle] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // 글쓰기 전용
  const [seriesMode, setSeriesMode] = useState(false);
  const [series, setSeries] = useState("");
  const [category, setCategory] = useState("");
  const [error, setError] = useState("");

  // 자동완성 목록 (글쓰기의 기존 분야·시리즈)
  const [categoryOptions, seriesOptions] = useMemo(() => {
    const cats = new Set<string>();
    const sers = new Set<string>();
    for (const n of notes) {
      if (n.note_type !== "writing") continue;
      const fm = n.frontmatter as Record<string, unknown> | null;
      if (fm && typeof fm === "object") {
        if (typeof fm.category === "string" && fm.category) cats.add(fm.category);
        if (typeof fm.series === "string" && fm.series) sers.add(fm.series);
      }
    }
    return [[...cats].sort(), [...sers].sort()] as const;
  }, [notes]);

  if (noteType === "daily") {
    openToday().then(onClose);
    return null;
  }

  const isWriting = noteType === "writing";
  const extras = creationFields(noteType, schema?.fields ?? []);
  const titleLabel = noteType === "reading" ? "책 제목" : "제목";
  const canSubmit = isWriting
    ? seriesMode
      ? !!series.trim()
      : !!title.trim()
    : !!title.trim();

  async function submit() {
    if (busy || !canSubmit) return;
    setError("");

    if (isWriting) {
      const fields: { [key: string]: JsonValue } = {};
      if (category.trim()) fields.category = category.trim();
      if (seriesMode) {
        const s = series.trim();
        if (nextEpisodeNumber(notes, s) > 1) {
          setError(
            `'${s}' 시리즈가 이미 있습니다. 글쓰기 대시보드의 [+ 다음 편 쓰기]로 이어가세요.`,
          );
          return;
        }
        fields.series = s;
        fields.episode = 1;
        fields.status = "draft";
        setBusy(true);
        try {
          await createNote(noteType, `${s} 0001편`, fields);
          onClose();
        } finally {
          setBusy(false);
        }
      } else {
        setBusy(true);
        try {
          await createNote(noteType, title.trim(), fields);
          onClose();
        } finally {
          setBusy(false);
        }
      }
      return;
    }

    const fields: { [key: string]: JsonValue } = {};
    for (const f of extras) {
      const v = values[f.name]?.trim();
      if (v) fields[f.name] = v;
    }
    if (noteType === "reading") {
      fields.book = `[[${title.trim()}]]`;
    }
    setBusy(true);
    try {
      await createNote(noteType, title.trim(), fields);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded border border-neutral-300 px-3 py-1.5 text-sm focus:border-neutral-500 focus:outline-none";

  return (
    <Modal onClose={onClose} panelClassName="w-96 rounded-lg p-5 shadow-xl">
        <h2 className="mb-4 text-base font-bold">
          {isWriting
            ? seriesMode
              ? "새 연재 시리즈 시작"
              : "새 글 만들기"
            : `${schema?.label ?? noteType} 만들기`}
        </h2>

        {isWriting && (
          <label className="mb-3 flex cursor-pointer items-center justify-between rounded-md border border-neutral-200 px-3 py-2">
            <span className="text-sm">
              시리즈 만들기
              <span className="block text-[11px] text-neutral-400">
                {seriesMode
                  ? "'시리즈명 0001편'부터 시작 — 이어쓰기는 [+ 다음 편 쓰기]로"
                  : "켜면 연재 시리즈를 시작합니다"}
              </span>
            </span>
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={seriesMode}
              onChange={(e) => {
                setSeriesMode(e.target.checked);
                setError("");
              }}
            />
          </label>
        )}

        <div className="flex flex-col gap-2">
          {isWriting ? (
            <>
              {seriesMode ? (
                <input
                  autoFocus
                  className={inputCls}
                  list="ynd-series"
                  placeholder="시리즈 제목 (예: 가상의 수필)"
                  value={series}
                  onChange={(e) => setSeries(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isImeEnter(e)) submit();
                    if (e.key === "Escape") onClose();
                  }}
                />
              ) : (
                <input
                  autoFocus
                  className={inputCls}
                  placeholder="제목"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isImeEnter(e)) submit();
                    if (e.key === "Escape") onClose();
                  }}
                />
              )}
              <input
                className={inputCls}
                list="ynd-categories"
                placeholder="분야 (선택 — 예: 에세이, 소설)"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !isImeEnter(e) && submit()}
              />
              <datalist id="ynd-series">
                {seriesOptions.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
              <datalist id="ynd-categories">
                {categoryOptions.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </>
          ) : (
            <>
              <input
                autoFocus
                className={inputCls}
                placeholder={titleLabel}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isImeEnter(e)) submit();
                  if (e.key === "Escape") onClose();
                }}
              />
              {extras.map((f) =>
                f.kind === "select" ? (
                  <select
                    key={f.name}
                    className={inputCls}
                    value={values[f.name] ?? ""}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [f.name]: e.target.value }))
                    }
                  >
                    <option value="">{f.label} 선택…</option>
                    {f.options.map((opt, i) => (
                      <option key={opt} value={opt}>
                        {f.option_labels[i] ?? opt}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    key={f.name}
                    className={inputCls}
                    placeholder={`${f.label}${f.required ? " *" : " (선택)"}`}
                    value={values[f.name] ?? ""}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [f.name]: e.target.value }))
                    }
                    onKeyDown={(e) => e.key === "Enter" && !isImeEnter(e) && submit()}
                  />
                ),
              )}
            </>
          )}
        </div>

        {error && <p className="mt-2 text-xs text-rose-500">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100"
            onClick={onClose}
          >
            취소
          </button>
          <button
            className="rounded bg-neutral-800 px-4 py-1.5 text-sm text-white hover:bg-neutral-600 disabled:opacity-50"
            disabled={busy || !canSubmit}
            onClick={submit}
          >
            {isWriting && seriesMode ? "시리즈 시작" : "만들기"}
          </button>
        </div>
    </Modal>
  );
}
