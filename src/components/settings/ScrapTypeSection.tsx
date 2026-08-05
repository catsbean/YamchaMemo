import { useEffect, useMemo } from "react";
import {
  useVault,
} from "../../stores/vault";

/** 스크랩(우클릭 저장) 기본 저장 분류. 책·데일리는 파일명·연동 규칙이
 *  확고해 고를 수 없다(백엔드 save_scrap과 같은 제약).
 *  고른 분류가 나중에 없어지면(커스텀 분류 삭제 등) 여기서 즉시 자유노트로
 *  되돌린다 — 저장 시점까지 기다리지 않는다. */
export default function ScrapTypeSection() {
  const schemas = useVault((s) => s.schemas);
  const scrapType = useVault((s) => s.scrapType);
  const setScrapType = useVault((s) => s.setScrapType);

  const options = useMemo(
    () => schemas.filter((s) => s.id !== "book" && s.id !== "daily"),
    [schemas],
  );

  useEffect(() => {
    if (scrapType !== "free" && !options.some((o) => o.id === scrapType)) {
      setScrapType("free");
    }
  }, [scrapType, options, setScrapType]);

  return (
    <section className="mb-5">
      <h3 className="mb-2 text-sm font-semibold text-neutral-600">
        스크랩 저장 위치
      </h3>
      <p className="mb-2 text-xs text-neutral-400">
        우클릭 [스크랩하기]로 저장할 때 쓸 기본 분류입니다. 고른 분류가 나중에
        사라지면 자유노트로 되돌아갑니다.
      </p>
      <select
        className="rounded border border-neutral-300 px-2 py-1 text-sm focus:border-neutral-500 focus:outline-none"
        value={options.some((o) => o.id === scrapType) ? scrapType : "free"}
        onChange={(e) => setScrapType(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </section>
  );
}
