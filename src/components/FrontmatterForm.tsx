import { useMemo } from "react";
import type {
  FieldDef,
  JsonValue,
  NoteSummary,
  TagSuggestion,
  TypeDef,
} from "../bindings";
import { aliasShadowedBy } from "../lib/resolveLink";
import TagSuggestionRow from "./TagSuggestionRow";

type FmObject = { [key: string]: JsonValue | undefined };

/** 한 칸에 모아 둘 과거 입력값 최대 개수 */
const MAX_OPTIONS = 50;
/** 이보다 긴 값은 고를 거리가 아니라 본문에 가깝다 */
const MAX_OPTION_LEN = 60;

/** 자동완성을 붙이지 않는 칸.
 *  제목은 편마다 달라야 하는 값이라, 지난 제목을 늘어놓으면 고르라고 부추기는 꼴이 된다.
 *  ISBN도 책마다 다르다. */
const NO_SUGGEST = new Set(["title", "isbn"]);

/**
 * 같은 분류의 노트들이 지금까지 각 칸에 넣은 값들 — 자주 쓴 것부터.
 *
 * 분야·저자·시리즈처럼 **같은 값을 되풀이해 넣는 칸**이 있는데, 매번 손으로 다시
 * 치면 '에세이'와 '에세이 '와 '엣세이'가 섞인다. 표기가 갈리면 대시보드에서
 * 다른 묶음이 되고, 사용자는 그걸 알아채기 어렵다. 지난 값을 보여 주면 대개 고른다.
 */
export function pastFieldValues(
  notes: NoteSummary[],
  typeId: string,
): Record<string, string[]> {
  const counts = new Map<string, Map<string, number>>();
  for (const n of notes) {
    if (n.note_type !== typeId) continue;
    const fm = n.frontmatter as Record<string, unknown> | null;
    if (!fm || typeof fm !== "object") continue;
    for (const [key, v] of Object.entries(fm)) {
      if (typeof v !== "string") continue;
      const s = v.trim();
      if (!s || s.length > MAX_OPTION_LEN) continue;
      let m = counts.get(key);
      if (!m) counts.set(key, (m = new Map()));
      m.set(s, (m.get(s) ?? 0) + 1);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [key, m] of counts) {
    out[key] = [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"))
      .slice(0, MAX_OPTIONS)
      .map(([v]) => v);
  }
  return out;
}

interface Props {
  schema: TypeDef | undefined;
  value: FmObject;
  onChange: (fm: FmObject) => void;
  /** image 필드의 [찾아보기] — 파일을 첨부하고 값 갱신까지 담당 */
  onPickImage?: (fieldName: string) => void;
  /** 자동 태그 제안 — tags 필드 옆에 칩으로 보여준다 */
  tagSuggestions?: TagSuggestion[];
  onAddTag?: (tag: string) => void;
  /** 자동완성 재료 — 같은 분류의 노트들. 없으면 자동완성 없이 그린다 */
  notes?: NoteSummary[];
}

/** frontmatter를 raw YAML 대신 스키마 기반 폼으로 표시·수정 */
export default function FrontmatterForm({
  schema,
  value,
  onChange,
  onPickImage,
  tagSuggestions,
  onAddTag,
  notes,
}: Props) {
  const options = useMemo(
    () => (schema && notes ? pastFieldValues(notes, schema.id) : {}),
    [notes, schema],
  );

  if (!schema) return null;

  function setField(name: string, v: JsonValue) {
    onChange({ ...value, [name]: v });
  }

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-b border-neutral-200 bg-neutral-50 px-4 py-3 text-sm md:grid-cols-3">
      {schema.fields.map((f) => (
        <Field
          key={f.name}
          def={f}
          typeId={schema.id}
          value={value[f.name]}
          onChange={(v) => setField(f.name, v)}
          onPickImage={onPickImage}
          // 자동 태그 제안은 **태그 칸의 것**이다. 별칭도 같은 위젯을 쓰므로
          // 종류가 아니라 이름으로 가려야 별칭 칸에 태그가 딸려 들어가지 않는다.
          tagSuggestions={f.name === "tags" ? tagSuggestions : undefined}
          onAddTag={f.name === "tags" ? onAddTag : undefined}
          options={NO_SUGGEST.has(f.name) ? undefined : options[f.name]}
          shadowedBy={
            f.name === "aliases" && notes
              ? (alias) => aliasShadowedBy(notes, alias)
              : undefined
          }
        />
      ))}
    </div>
  );
}

/** 적어 넣었지만 다른 글에 가려 쓰이지 않는 별칭을 그 자리에서 알린다.
 *
 *  별칭이 제목·파일명에게 지는 것은 옳은 규칙이지만(그래야 남의 링크를 가로채지
 *  않는다), 적은 사람에게는 아무 일도 안 일어난 것처럼 보인다. 조용히 무시하는
 *  대신 왜 안 되는지를 밝힌다. 막지는 않는다 — 가리던 글이 나중에 사라지면
 *  그때부터 이 별칭이 살아난다. */
function ShadowedAliases({
  items,
  shadowedBy,
}: {
  items: string[];
  shadowedBy: (alias: string) => string | null;
}) {
  const dead = items
    .map((a) => [a, shadowedBy(a)] as const)
    .filter((p): p is readonly [string, string] => p[1] !== null);
  if (dead.length === 0) return null;
  return (
    <span className="mt-0.5 text-2xs text-amber-600">
      {dead.map(([alias, owner]) => (
        <span key={alias} className="block">
          '{alias}'은(는) '{owner}' 글의 이름이라 이 별칭으로는 오지 않습니다
        </span>
      ))}
    </span>
  );
}

function Field({
  def,
  typeId,
  value,
  onChange,
  onPickImage,
  tagSuggestions,
  onAddTag,
  options,
  shadowedBy,
}: {
  def: FieldDef;
  typeId: string;
  value: JsonValue | undefined;
  onChange: (v: JsonValue) => void;
  onPickImage?: (fieldName: string) => void;
  tagSuggestions?: TagSuggestion[];
  onAddTag?: (tag: string) => void;
  options?: string[];
  /** 별칭 칸에서만 — 이 값이 다른 이름에 가려 쓰이지 않으면 그 글의 이름 */
  shadowedBy?: (alias: string) => string | null;
}) {
  // 필수 표시(*)를 붙이지 않는다 — 비워 둬도 저장되므로 지키지 않는 약속이었다
  const label = (
    <span className="text-xs font-medium text-neutral-500">{def.label}</span>
  );
  const inputCls =
    "w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm focus:border-neutral-500 focus:outline-none";

  switch (def.kind) {
    case "select":
      return (
        <label className="flex flex-col gap-0.5">
          {label}
          <select
            className={inputCls}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          >
            {def.options.map((opt, i) => (
              <option key={opt} value={opt}>
                {def.option_labels[i] ?? opt}
              </option>
            ))}
          </select>
        </label>
      );
    case "date":
      return (
        <label className="flex flex-col gap-0.5">
          {label}
          <input
            type="date"
            className={inputCls}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      );
    case "number":
      return (
        <label className="flex flex-col gap-0.5">
          {label}
          <input
            type="number"
            min={0}
            max={5}
            step={0.5}
            className={inputCls}
            value={typeof value === "number" ? value : ""}
            onChange={(e) =>
              onChange(e.target.value === "" ? null : Number(e.target.value))
            }
          />
        </label>
      );
    case "tags": {
      const items = Array.isArray(value)
        ? value.filter((t): t is string => typeof t === "string")
        : [];
      const suggestions = (tagSuggestions ?? []).filter(
        (s) => !items.includes(s.tag),
      );
      const isAliases = def.name === "aliases";
      return (
        <label className="flex flex-col gap-0.5">
          {label}
          <input
            className={inputCls}
            placeholder={isAliases ? "쉼표로 구분 — 이 이름으로도 링크됨" : "쉼표로 구분"}
            title={
              isAliases
                ? "여기 적은 이름으로 [[링크]]해도 이 글이 열립니다. 같은 이름의 글이 따로 있으면 그 글이 우선입니다."
                : undefined
            }
            value={items.join(", ")}
            onChange={(e) =>
              onChange(
                e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
          />
          {onAddTag && (
            <TagSuggestionRow suggestions={suggestions} onAdd={onAddTag} />
          )}
          {shadowedBy && <ShadowedAliases items={items} shadowedBy={shadowedBy} />}
        </label>
      );
    }
    case "image":
      return (
        <label className="flex flex-col gap-0.5">
          {label}
          <span className="flex gap-1">
            <input
              className={inputCls}
              placeholder="URL 또는 첨부 경로"
              value={typeof value === "string" ? value : ""}
              onChange={(e) => onChange(e.target.value)}
            />
            {onPickImage && (
              <button
                type="button"
                className="shrink-0 rounded border border-neutral-300 bg-white px-2 text-xs hover:border-neutral-500"
                onClick={() => onPickImage(def.name)}
              >
                찾아보기
              </button>
            )}
          </span>
        </label>
      );
    default: {
      // text / url / wikilink
      // 지난 값 자동완성은 text에만 — url·wikilink는 편마다 다른 값이라 고를 거리가 못 된다
      const listId =
        def.kind === "text" && options && options.length > 0
          ? `fm-opt-${typeId}-${def.name}`
          : undefined;
      return (
        <label className="flex flex-col gap-0.5">
          {label}
          <input
            className={inputCls}
            list={listId}
            placeholder={def.kind === "wikilink" ? "[[노트 제목]]" : ""}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          />
          {listId && (
            <datalist id={listId}>
              {options!.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          )}
        </label>
      );
    }
  }
}
