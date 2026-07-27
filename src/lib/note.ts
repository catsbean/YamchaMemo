// 노트/책 공통 유틸 — 여러 컴포넌트에 흩어져 있던 중복 로직을 모았다.
import { convertFileSrc } from "@tauri-apps/api/core";

/** 책 상태 코드 → 한국어 라벨 */
export const BOOK_STATUS_LABELS: Record<string, string> = {
  wishlist: "읽고 싶은 책",
  reading: "읽는 중",
  finished: "완독",
  paused: "중단",
};

/** 책장/그룹 정렬용 상태 순서 */
export const BOOK_STATUS_ORDER = ["reading", "wishlist", "finished", "paused"];

/** frontmatter 문자열 필드를 안전하게 꺼낸다.
 *  NoteSummary(=.frontmatter 보유)와 순수 frontmatter 객체를 모두 수용한다. */
export function fmStr(source: unknown, key: string): string {
  if (!source || typeof source !== "object") return "";
  const fm =
    "frontmatter" in source
      ? (source as { frontmatter: unknown }).frontmatter
      : source;
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) return "";
  const v = (fm as Record<string, unknown>)[key];
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

/** 표지 cover 값(vault 상대경로 또는 http URL)을 <img src>로 변환 */
export function coverSrc(vaultPath: string | null, cover: string): string {
  if (!cover) return "";
  if (/^https?:\/\//i.test(cover)) return cover;
  if (!vaultPath) return "";
  return convertFileSrc(`${vaultPath}\\${cover.replace(/\//g, "\\")}`);
}
