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

/** 제목이 같은 노트를 구별하려고 파일명에만 붙는 꼬리표를 돌려준다.
 *
 *  제목이 "제목"인 노트가 둘이면 파일은 `제목.md` · `제목 (2).md`가 되는데,
 *  목록은 frontmatter의 제목만 보여 줘서 둘 다 "제목"으로 보인다.
 *  그 차이(" (2)")를 뽑아 목록에서 흐리게 덧붙이려고 쓴다.
 *  제목과 파일명이 아예 다르면(직접 지은 제목 등) 굳이 붙이지 않는다. */
export function fileSuffix(note: { rel_path: string; title: string }): string {
  const stem = note.rel_path.split("/").pop()?.replace(/\.md$/, "") ?? "";
  if (!stem || stem === note.title) return "";
  return stem.startsWith(note.title) ? stem.slice(note.title.length) : "";
}

/** 표지 cover 값(vault 상대경로 또는 http URL)을 <img src>로 변환 */
export function coverSrc(vaultPath: string | null, cover: string): string {
  if (!cover) return "";
  if (/^https?:\/\//i.test(cover)) return cover;
  if (!vaultPath) return "";
  return convertFileSrc(`${vaultPath}\\${cover.replace(/\//g, "\\")}`);
}
