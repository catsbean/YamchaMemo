import { useVault } from "../../stores/vault";
import CustomTypeRow from "./CustomTypeRow";

/** 사용자 추가 분류 — 목록에 보일 칸·본문 템플릿·제거. 없으면 아무것도 그리지 않는다. */
export default function CustomTypesSection() {
  const schemas = useVault((s) => s.schemas);
  const removeCustom = useVault((s) => s.refreshSchemas);
  const customs = schemas.filter((s) => !s.builtin);
  if (customs.length === 0) return null;

  return (
    <section className="mb-5">
                <h3 className="mb-2 text-sm font-semibold text-neutral-600">
                  사용자 추가 분류
                </h3>
                <p className="mb-2 text-xs text-neutral-400">
                  분류마다 <b>목록에 함께 보일 칸</b>과 새 노트의 <b>본문 템플릿</b>을
                  정합니다. 켠 칸은 그 분류의 목록에서 제목 옆에 값이 붙습니다(날짜·태그는
                  늘 보이므로 고르는 대상이 아닙니다). 템플릿은 frontmatter를 건드리지
                  않으며 이미 만든 노트에도 영향을 주지 않습니다 —{" "}
                  <code>{"{{date}}"}</code>, <code>{"{{title}}"}</code> 등의 자리표시자를
                  쓸 수 있습니다.
                </p>
                <ul className="flex flex-col gap-2">
                  {customs.map((s) => (
                    <CustomTypeRow
                      key={s.id}
                      id={s.id}
                      label={s.label}
                      fields={s.fields}
                      template={s.template}
                      onRemoved={removeCustom}
                      onTemplateSaved={removeCustom}
                    />
                  ))}
                </ul>
              </section>
  );
}
