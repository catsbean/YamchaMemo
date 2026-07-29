import { useState } from "react";
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
}

const EMPTY_ROW: FieldRow = {
  name: "",
  label: "",
  kind: "text",
  required: false,
  options: "",
};

/** 사용자 정의 분류 생성: 이름 + 추가 frontmatter 필드 + 본문 템플릿 */
export default function CustomTypeDialog({ onClose }: { onClose: () => void }) {
  const addCustomType = useVault((s) => s.addCustomType);
  const [label, setLabel] = useState("");
  const [rows, setRows] = useState<FieldRow[]>([{ ...EMPTY_ROW }]);
  const [template, setTemplate] = useState("");
  const [busy, setBusy] = useState(false);

  function setRow(i: number, patch: Partial<FieldRow>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function submit() {
    if (busy || !label.trim()) return;
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
          };
        });
      const ok = await addCustomType(label.trim(), fields, template);
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
              <code className="text-neutral-700">type</code> — 분류 이름 (자동
              입력, 수정 불가)
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
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>

        <div className="mb-3">
          <span className="text-xs font-medium text-neutral-500">
            추가 frontmatter 필드
          </span>
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
                    className={`${inputCls} flex-1`}
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
            disabled={busy || !label.trim()}
            onClick={submit}
          >
            만들기
          </button>
        </div>
    </Modal>
  );
}
