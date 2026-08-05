import { useEffect, useState } from "react";
import { commands } from "../bindings";
import { useVault } from "../stores/vault";
import Modal from "./Modal";

/** URL의 호스트만 (실패했을 때 제목 기본값 재료로 쓴다) */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const VIA_LABEL: Record<string, string> = {
  html: "",
  render: "페이지를 직접 열어서 가져왔습니다",
};

/** 웹 스크랩 팝업 — 우클릭 "스크랩하기"로 뜬다.
 *
 *  담기 창·회고 팝업과 같은 자리(모달)를 쓰지만 이건 "만들어서 바로 편집"이 핵심이라
 *  본문을 통째로 고칠 수 있는 큰 textarea를 둔다. 저장을 눌러야 파일이 생긴다 —
 *  먼저 만들고 취소 때 지우면 휴지통·히스토리·감시가 다 얽히기 때문이다. */
export default function ScrapModal({
  url,
  onClose,
  onSaved,
}: {
  url: string;
  onClose: () => void;
  /** 저장이 끝나면 파일명(확장자 없이)을 넘긴다 — 호출부가 원래 URL 자리를
   *  `[[제목]]`으로 갈아끼울 수 있게 */
  onSaved: (stem: string) => void;
}) {
  const refresh = useVault((s) => s.refresh);
  const scrapType = useVault((s) => s.scrapType);
  const setScrapType = useVault((s) => s.setScrapType);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState(hostOf(url));
  const [body, setBody] = useState("");
  const [via, setVia] = useState<string | null>(null);
  const [gotArticle, setGotArticle] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    commands.scrapeArticle(url).then((r) => {
      if (!alive) return;
      setLoading(false);
      if (r) {
        setTitle(r.title || hostOf(url));
        setBody(r.body_md);
        setVia(r.via);
        setGotArticle(true);
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  async function save() {
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    const r = await commands.saveScrap(title, url, body, scrapType);
    setSaving(false);
    if (r.status === "error") {
      setError(r.error);
      return;
    }
    // 요청한 분류가 없어져서 백엔드가 자유노트로 대신 저장했으면, 설정도 맞춰 둔다
    if (r.data.type_id !== scrapType) await setScrapType(r.data.type_id);
    await refresh();
    const stem = r.data.rel.split("/").pop()?.replace(/\.md$/, "") ?? title.trim();
    onSaved(stem);
  }

  return (
    <Modal
      onClose={onClose}
      panelClassName="flex h-[calc(100vh-4rem)] w-[min(760px,92vw)] flex-col overflow-hidden rounded-xl shadow-2xl"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-5 py-3">
        <h2 className="text-base font-bold text-neutral-900">📎 스크랩하기</h2>
        <span className="min-w-0 flex-1 truncate text-xs text-neutral-400">
          {url}
        </span>
        <button
          className="rounded border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
          onClick={onClose}
          title="아무것도 남기지 않고 닫습니다"
        >
          취소
        </button>
        <button
          className="rounded bg-neutral-800 px-4 py-1 text-sm text-white hover:bg-neutral-600 disabled:opacity-40"
          disabled={!title.trim() || saving}
          onClick={save}
        >
          {saving ? "저장 중…" : "저장"}
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-5 py-3">
        <input
          className="shrink-0 rounded border border-neutral-300 px-2 py-1.5 text-sm font-medium focus:border-neutral-500 focus:outline-none"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="제목"
        />

        {loading && (
          <p className="mt-6 text-center text-sm text-neutral-400">
            페이지를 여는 중…
          </p>
        )}

        {!loading && !gotArticle && (
          <p className="text-xs text-amber-700">
            본문을 가져오지 못했습니다. 브라우저에서 복사해 아래에 붙여넣으세요.
          </p>
        )}

        {!loading && gotArticle && via && VIA_LABEL[via] && (
          <p className="text-2xs text-neutral-400">{VIA_LABEL[via]}</p>
        )}

        {!loading && (
          <textarea
            className="min-h-0 flex-1 resize-none rounded border border-neutral-300 px-3 py-2 font-mono text-sm leading-relaxed focus:border-neutral-500 focus:outline-none"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={
              gotArticle ? undefined : "여기에 붙여넣거나 직접 적으세요"
            }
          />
        )}

        {error && <p className="shrink-0 text-xs text-rose-600">{error}</p>}
      </div>
    </Modal>
  );
}
