import type { FieldDef, JsonValue, TagSuggestion, TypeDef } from "../bindings";
import TagSuggestionRow from "./TagSuggestionRow";

type FmObject = { [key: string]: JsonValue | undefined };

interface Props {
  schema: TypeDef | undefined;
  value: FmObject;
  onChange: (fm: FmObject) => void;
  /** image 필드의 [찾아보기] — 파일을 첨부하고 값 갱신까지 담당 */
  onPickImage?: (fieldName: string) => void;
  /** 자동 태그 제안 — tags 필드 옆에 칩으로 보여준다 */
  tagSuggestions?: TagSuggestion[];
  onAddTag?: (tag: string) => void;
}

/** frontmatter를 raw YAML 대신 스키마 기반 폼으로 표시·수정 */
export default function FrontmatterForm({
  schema,
  value,
  onChange,
  onPickImage,
  tagSuggestions,
  onAddTag,
}: Props) {
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
          value={value[f.name]}
          onChange={(v) => setField(f.name, v)}
          onPickImage={onPickImage}
          tagSuggestions={f.kind === "tags" ? tagSuggestions : undefined}
          onAddTag={f.kind === "tags" ? onAddTag : undefined}
        />
      ))}
    </div>
  );
}

function Field({
  def,
  value,
  onChange,
  onPickImage,
  tagSuggestions,
  onAddTag,
}: {
  def: FieldDef;
  value: JsonValue | undefined;
  onChange: (v: JsonValue) => void;
  onPickImage?: (fieldName: string) => void;
  tagSuggestions?: TagSuggestion[];
  onAddTag?: (tag: string) => void;
}) {
  const label = (
    <span className="text-xs font-medium text-neutral-500">
      {def.label}
      {def.required && <span className="text-rose-400"> *</span>}
    </span>
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
      const tags = Array.isArray(value)
        ? value.filter((t): t is string => typeof t === "string")
        : [];
      const suggestions = (tagSuggestions ?? []).filter(
        (s) => !tags.includes(s.tag),
      );
      return (
        <label className="flex flex-col gap-0.5">
          {label}
          <input
            className={inputCls}
            placeholder="쉼표로 구분"
            value={tags.join(", ")}
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
    default:
      // text / url / wikilink
      return (
        <label className="flex flex-col gap-0.5">
          {label}
          <input
            className={inputCls}
            placeholder={def.kind === "wikilink" ? "[[노트 제목]]" : ""}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      );
  }
}
