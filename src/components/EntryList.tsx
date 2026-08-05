import { useEffect, useRef, useState } from "react";
import { commands, type NoteBlock, type NoteContent } from "../bindings";
import {
  DAILY_KINDS,
  kindByLabel,
  styleOf,
  type CalloutKind,
} from "../lib/callouts";
import { useVault } from "../stores/vault";
import { useImeInput } from "../lib/ime";
import WikiLinkSuggest from "./WikiLinkSuggest";
import NoteText from "./NoteText";

/** 콜아웃 종류별 색 — 입력 바·본문 렌더와 같은 계열 */
const KIND_STYLE: Record<string, string> = {
  발췌: "border-amber-200 bg-amber-50 text-amber-800",
  생각: "border-sky-200 bg-sky-50 text-sky-800",
  요약: "border-emerald-200 bg-emerald-50 text-emerald-800",
  질문: "border-violet-200 bg-violet-50 text-violet-800",
  기록: "border-sky-200 bg-sky-50 text-sky-800",
  느낌: "border-amber-200 bg-amber-50 text-amber-800",
};
const KIND_ICON: Record<string, string> = {
  발췌: "📌",
  생각: "💭",
  요약: "📋",
  질문: "❓",
  기록: "🕘",
  느낌: "💛",
};

/** 이 화면이 일지인지 책인지로 커스텀 콜아웃을 걸러낸다 */
function scopeMatches(scope: string, kinds: CalloutKind[]): boolean {
  const isDaily = kinds.some((k) => k.label === DAILY_KINDS[0].label);
  const target = isDaily ? "daily" : "book";
  return scope === target || scope === "both";
}

/** 기록 보기 — 콜아웃은 항목별 수정·삭제, 콜아웃이 아닌 내용은 '원문' 카드로 그대로 보여준다.
 *  (외부 편집기에서 써 넣은 내용을 화면이 숨기지 않도록) */
export default function EntryList({
  relPath,
  body,
  onChanged,
  onOpenRaw,
  kinds,
}: {
  relPath: string;
  /** 본문 — 바뀔 때마다 목록을 다시 읽는 신호로 쓴다 */
  body: string;
  onChanged: (note: NoteContent) => void;
  /** '원문 편집' 모드로 전환 */
  onOpenRaw: () => void;
  /** 이 화면에서 고를 수 있는 종류 (수정 시 종류 변경 드롭다운) */
  kinds: CalloutKind[];
}) {
  const [blocks, setBlocks] = useState<NoteBlock[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 수정 중 고른 종류 (원래와 다르면 저장할 때 함께 바꾼다)
  const [draftKind, setDraftKind] = useState("");
  const customs = useVault((s) => s.callouts);

  /** 기본 종류 + 이 화면에 해당하는 커스텀 콜아웃 */
  const allKinds: CalloutKind[] = [
    ...kinds,
    ...customs
      .filter((c) => scopeMatches(c.scope, kinds))
      .map((c) => ({
        label: c.label,
        icon: c.icon,
        color: c.color as CalloutKind["color"],
      })),
  ];
  const customStyle = (label: string) =>
    styleOf(kindByLabel(label, allKinds).color).card;
  /** 등록된 종류면 그 아이콘(없음이면 빈 문자열), 모르는 종류면 💬 */
  const iconOf = (label: string) => {
    const found = allKinds.find((k) => k.label === label);
    return found ? found.icon : "💬";
  };

  useEffect(() => {
    commands.noteBlocks(relPath).then((r) => {
      if (r.status === "ok") setBlocks(r.data);
    });
  }, [relPath, body]);

  useEffect(() => {
    if (confirming === null) return;
    const t = setTimeout(() => setConfirming(null), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  /** 내용 → 종류 순으로 적용한다 (종류를 먼저 바꾸면 인덱스·섹션이 흔들린다) */
  async function saveEdit(
    index: number,
    expected: string,
    curKind: string,
    value: string,
  ) {
    const draftText = value.trim();
    if (busy || !draftText) return;
    setBusy(true);
    setError("");
    let r = await commands.updateEntry(relPath, index, expected, draftText);
    if (r.status === "ok" && draftKind && draftKind !== curKind) {
      r = await commands.changeKind(relPath, "entry", index, draftText, draftKind);
    }
    if (r.status === "ok") {
      setEditing(null);
      onChanged(r.data);
    } else {
      setError(r.error);
    }
    setBusy(false);
  }

  // 수정 중인 항목을 ref로 들고 훅에 넘긴다 (조합 종료가 한 틱 늦게 오므로)
  const editingRef = useRef<{ index: number; text: string; kind: string } | null>(
    null,
  );
  const editIme = useImeInput<HTMLTextAreaElement>(
    (v) => {
      const t = editingRef.current;
      if (t) saveEdit(t.index, t.text, t.kind, v);
    },
    "ctrl-enter",
    () => setEditing(null),
  );

  async function remove(index: number, expected: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    const r = await commands.deleteEntry(relPath, index, expected);
    if (r.status === "ok") {
      setConfirming(null);
      onChanged(r.data);
    } else {
      setError(r.error);
    }
    setBusy(false);
  }

  if (blocks.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 px-4 py-2">
      {error && <p className="text-xs text-rose-500">{error}</p>}

      {blocks.map((b, i) => {
        // 콜아웃이 아닌 원문 — 보여만 주고, 손보려면 원문 편집으로 보낸다
        if (b.kind !== "callout" || b.entry_index === null) {
          return (
            <div
              key={`raw-${i}`}
              className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 px-3 py-2"
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-neutral-500">
                  📄 원문
                  {b.section && (
                    <span className="ml-1.5 font-normal text-neutral-400">
                      {b.section}
                    </span>
                  )}
                </span>
                <button
                  className="shrink-0 rounded border border-neutral-300 px-2 py-0.5 text-2xs text-neutral-600 hover:border-neutral-500"
                  onClick={onOpenRaw}
                  title="이 내용은 기록 형식이 아니라 원문에서 고칩니다"
                >
                  원문 편집
                </button>
              </div>
              <NoteText
                text={b.text}
                className="whitespace-pre-wrap text-sm text-neutral-700"
              />
            </div>
          );
        }

        const index = b.entry_index;
        const style = KIND_STYLE[b.kind_label] ?? customStyle(b.kind_label);
        return (
          <div key={`e-${index}`} className={`rounded-md border px-3 py-2 ${style}`}>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold">
                {(() => {
                  const ic = KIND_ICON[b.kind_label] ?? iconOf(b.kind_label);
                  return ic ? `${ic} ` : "";
                })()}
                {b.kind_label}
                {b.date && (
                  <span className="ml-1.5 font-normal opacity-60">{b.date}</span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {editing === index ? (
                  <>
                    <button
                      className="rounded bg-neutral-800 px-2 py-0.5 text-2xs text-white hover:bg-neutral-600 disabled:opacity-50"
                      disabled={busy}
                      onClick={() => saveEdit(index, b.text, b.kind_label, editIme.value())}
                    >
                      저장
                    </button>
                    <button
                      className="rounded px-1.5 py-0.5 text-2xs opacity-70 hover:bg-white/60"
                      onClick={() => setEditing(null)}
                    >
                      취소
                    </button>
                  </>
                ) : confirming === index ? (
                  <>
                    <button
                      className="rounded bg-rose-600 px-2 py-0.5 text-2xs font-bold text-white hover:bg-rose-500 disabled:opacity-50"
                      disabled={busy}
                      onClick={() => remove(index, b.text)}
                    >
                      삭제 확인
                    </button>
                    <button
                      className="rounded px-1.5 py-0.5 text-2xs opacity-70 hover:bg-white/60"
                      onClick={() => setConfirming(null)}
                    >
                      취소
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="rounded px-1.5 py-0.5 text-2xs opacity-70 hover:bg-white/60"
                      onClick={() => {
                        setEditing(index);
                        setDraftKind(b.kind_label);
                        editingRef.current = {
                          index,
                          text: b.text,
                          kind: b.kind_label,
                        };
                        setConfirming(null);
                      }}
                    >
                      수정
                    </button>
                    <button
                      className="rounded px-1.5 py-0.5 text-2xs text-rose-500 hover:bg-white/60"
                      onClick={() => {
                        setConfirming(index);
                        setEditing(null);
                      }}
                    >
                      삭제
                    </button>
                  </>
                )}
              </span>
            </div>
            {editing === index ? (
              <>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-2xs text-neutral-500">종류</span>
                  <select
                    className="rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-2xs text-neutral-700 focus:outline-none"
                    value={draftKind}
                    onChange={(ev) => setDraftKind(ev.target.value)}
                  >
                    {!allKinds.some((k) => k.label === b.kind_label) && (
                      <option value={b.kind_label}>{b.kind_label}</option>
                    )}
                    {allKinds.map((k) => (
                      <option key={k.label} value={k.label}>
                        {k.icon} {k.label}
                      </option>
                    ))}
                    <option value="할 일">☑ 할 일로 옮기기</option>
                  </select>
                  {draftKind === "할 일" && (
                    <span className="text-2xs text-amber-600">
                      할 일 목록으로 이동합니다
                    </span>
                  )}
                </div>
                <div className="relative">
                  <textarea
                  autoFocus
                  className="min-h-16 w-full resize-y rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-800 focus:outline-none"
                  defaultValue={b.text}
                  key={`edit-${index}`}
                  {...editIme.handlers}
                  />
                  <WikiLinkSuggest inputRef={editIme.handlers.ref} />
                </div>
              </>
            ) : (
              <NoteText
                text={b.text}
                className="whitespace-pre-wrap text-sm text-neutral-800"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
