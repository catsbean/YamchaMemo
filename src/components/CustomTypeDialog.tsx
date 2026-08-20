import { useMemo, useState } from "react";
import type { FieldDef, FieldKind } from "../bindings";
import { useVault } from "../stores/vault";
import Modal from "./Modal";

const KIND_OPTIONS: { value: FieldKind; label: string }[] = [
  { value: "text", label: "텍스트" },
  { value: "date", label: "날짜" },
  { value: "select", label: "선택지" },
  { value: "number", label: "숫자" },
  { value: "url", label: "URL" },
  { value: "image", label: "이미지" },
  { value: "wikilink", label: "위키링크" },
];

interface FieldRow {
  name: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  options: string; // 쉼표 구분 (select일 때)
  inList: boolean; // 목록 줄에 값을 뱃지로 내보일지
}

const EMPTY_ROW: FieldRow = {
  name: "",
  label: "",
  kind: "text",
  required: false,
  options: "",
  inList: false,
};

/** 사용자 정의 분류 생성: 이름 + 추가 frontmatter 필드 + 본문 템플릿 */
export default function CustomTypeDialog({ onClose }: { onClose: () => void }) {
  const addCustomType = useVault((s) => s.addCustomType);
  const schemas = useVault((s) => s.schemas);
  const [label, setLabel] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [rows, setRows] = useState<FieldRow[]>([{ ...EMPTY_ROW }]);
  const [template, setTemplate] = useState("");
  const [busy, setBusy] = useState(false);

  // 내장 4종 + 이미 만든 커스텀 분류 — 타입 ID로 쓸 수 없는 값들을 미리 보여 준다
  const takenIds = useMemo(
    () => schemas.map((s) => s.id).sort((a, b) => a.localeCompare(b)),
    [schemas],
  );
  const idConflict = id.trim() !== "" && takenIds.includes(id.trim());

  function setRow(i: number, patch: Partial<FieldRow>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function submit() {
    if (busy || !label.trim() || !id.trim() || idConflict) return;
    setBusy(true);
    try {
      const fields: FieldDef[] = rows
        .filter((r) => r.name.trim())
        .map((r) => {
          const options =
            r.kind === "select"
              ? r.options.split(",").map((s) => s.trim()).filter(Boolean)
              : [];
          return {
            name: r.name.trim(),
            label: r.label.trim() || r.name.trim(),
            kind: r.kind,
            required: r.required,
            options,
            option_labels: options,
            in_list: r.inList,
          };
        });
      const ok = await addCustomType(label.trim(), id.trim(), fields, template);
      if (ok) onClose();
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "rounded border border-neutral-300 px-2 py-1 text-sm focus:border-neutral-500 focus:outline-none";

  return (
    <Modal
      onClose={onClose}
      panelClassName="max-h-[85vh] w-[36rem] overflow-y-auto rounded-lg p-5 shadow-xl"
    >
        <h2 className="mb-1 text-base font-bold">새 분류 만들기</h2>
        <p className="mb-3 text-xs text-neutral-500">
          분류 이름으로 vault 안에 폴더가 만들어지고, 이 분류의 노트는 모두 그
          폴더에 저장됩니다.
        </p>

        <div className="mb-4 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2">
          <p className="mb-1 text-xs font-semibold text-neutral-600">
            필수 frontmatter — 모든 노트에 자동으로 포함됩니다
          </p>
          <ul className="text-2xs leading-5 text-neutral-500">
            <li>
              <code className="text-neutral-700">date</code> — 작성일 (생성 시
              오늘 날짜로 자동 입력)
            </li>
            <li>
              <code className="text-neutral-700">type</code> — 아래 "타입 ID"로
              직접 정한 값
            </li>
            <li>
              <code className="text-neutral-700">tags</code> — 태그 목록 (빈
              목록으로 시작, 태그 화면에서 모아볼 수 있음)
            </li>
          </ul>
        </div>

        <label className="mb-3 block">
          <span className="text-xs font-medium text-neutral-500">분류 이름 *</span>
          <input
            autoFocus
            className={`${inputCls} mt-0.5 w-full`}
            placeholder="예: 회의록, 여행기록, 레시피"
            value={label}
            onChange={(e) => {
              const v = e.target.value;
              setLabel(v);
              if (!idTouched) setId(v);
            }}
          />
        </label>

        <label className="mb-3 block">
          <span className="text-xs font-medium text-neutral-500">
            타입 ID (frontmatter type 값) *
          </span>
          <input
            className={`${inputCls} mt-0.5 w-full ${idConflict ? "border-rose-400" : ""}`}
            placeholder="예: meeting"
            value={id}
            onChange={(e) => {
              setId(e.target.value);
              setIdTouched(true);
            }}
          />
          {idConflict ? (
            <span className="mt-0.5 block text-2xs text-rose-500">
              이미 쓰고 있는 ID입니다. 다른 값을 정해 주세요.
            </span>
          ) : (
            <span className="mt-0.5 block text-2xs text-neutral-400">
              노트 파일의 frontmatter에 저장되는 값입니다. 공백·슬래시는 쓸 수
              없습니다.
            </span>
          )}
          {takenIds.length > 0 && (
            <span className="mt-0.5 block text-2xs text-neutral-400">
              이미 쓰는 ID: {takenIds.join(", ")}
            </span>
          )}
        </label>

        <div className="mb-3">
          <span className="text-xs font-medium text-neutral-500">
            추가 frontmatter 필드
          </span>
          <p className="text-2xs text-neutral-400">
            [목록]을 켜면 이 분류의 목록에서 제목 옆에 그 칸의 값이 함께 보입니다
            (나중에 설정 &gt; 기록에서 바꿀 수 있습니다).
          </p>
          <div className="mt-1 flex flex-col gap-1.5">
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  className={`${inputCls} w-28`}
                  placeholder="필드명(영문)"
                  value={r.name}
                  onChange={(e) => setRow(i, { name: e.target.value })}
                />
                <input
                  className={`${inputCls} w-24`}
                  placeholder="표시 이름"
                  value={r.label}
                  onChange={(e) => setRow(i, { label: e.target.value })}
                />
                <select
                  className={inputCls}
                  value={r.kind}
                  onChange={(e) => setRow(i, { kind: e.target.value as FieldKind })}
                >
                  {KIND_OPTIONS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
                {r.kind === "select" && (
                  <input
                    // min-w-0이 없으면 flex-1이 줄어들지 못해(기본 min-width:auto)
                    // 칸이 하나 늘어난 지금은 줄이 창 밖으로 밀린다
                    className={`${inputCls} w-0 min-w-0 flex-1`}
                    placeholder="선택지 (쉼표 구분)"
                    value={r.options}
                    onChange={(e) => setRow(i, { options: e.target.value })}
                  />
                )}
                <label className="flex items-center gap-1 text-xs text-neutral-500">
                  <input
                    type="checkbox"
                    checked={r.required}
                    onChange={(e) => setRow(i, { required: e.target.checked })}
                  />
                  필수
                </label>
                <label
                  className="flex items-center gap-1 text-xs text-neutral-500"
                  title="이 분류의 목록에서 각 줄에 이 칸의 값을 함께 보여줍니다"
                >
                  <input
                    type="checkbox"
                    checked={r.inList}
                    onChange={(e) => setRow(i, { inList: e.target.checked })}
                  />
                  목록
                </label>
                <button
                  className="px-1 text-neutral-400 hover:text-rose-500"
                  onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                  title="필드 삭제"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              className="self-start rounded border border-dashed border-neutral-300 px-2 py-1 text-xs text-neutral-400 hover:border-neutral-400 hover:text-neutral-600"
              onClick={() => setRows((rs) => [...rs, { ...EMPTY_ROW }])}
            >
              + 필드 추가
            </button>
          </div>
        </div>

        <label className="mb-4 block">
          <span className="text-xs font-medium text-neutral-500">
            본문 템플릿 ({"{{date}}"}, {"{{title}}"} 사용 가능)
          </span>
          <textarea
            className={`${inputCls} mt-0.5 h-28 w-full resize-y font-mono text-xs`}
            placeholder={"## 안건\n\n## 결정사항\n"}
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          />
        </label>

        <div className="flex justify-end gap-2">
          <button
            className="rounded px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100"
            onClick={onClose}
          >
            취소
          </button>
          <button
            className="rounded bg-neutral-800 px-4 py-1.5 text-sm text-white hover:bg-neutral-600 disabled:opacity-50"
            disabled={busy || !label.trim() || !id.trim() || idConflict}
            onClick={submit}
          >
            만들기
          </button>
        </div>
    </Modal>
  );
}
