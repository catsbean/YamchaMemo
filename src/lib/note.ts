// 노트/책 공통 유틸 — 여러 컴포넌트에 흩어져 있던 중복 로직을 모았다.
import { convertFileSrc } from "@tauri-apps/api/core";
import { sep } from "@tauri-apps/api/path";

/** vault 루트 + vault 상대경로 → `<img src>`로 쓸 asset URL.
 *
 *  구분자는 **플랫폼에서 받아 온다**. 예전에는 `\`를 박아 뒀는데, Mac에서는 그게
 *  경로 구분이 아니라 파일 이름에 든 글자라서 `/Users/me/vault\_attachments\...`
 *  같은 없는 파일을 가리켰다 — 표지와 본문 이미지가 통째로 안 보였다. */
export function vaultAssetSrc(vaultPath: string, rel: string): string {
  const s = sep();
  return convertFileSrc(`${vaultPath}${s}${rel.replace(/[\\/]/g, s)}`);
}

/** 파일명·연동 규칙이 확고해 임의의 제목으로 만들거나 다른 폴더로 옮길 수 없는 분류 —
 *  책은 도서 정보가, 일지는 날짜가 파일명을 정한다. (백엔드 `move_note`·`save_scrap`의
 *  제약과 같다. 여기서 미리 걸러 눌러도 안 되는 메뉴를 안 보여 주려는 것뿐이다.) */
export const FIXED_NAMING_TYPES = ["book", "daily"];

/** 다른 분류로 옮길 수 있는 노트인가 */
export function canMoveType(typeId: string): boolean {
  return !FIXED_NAMING_TYPES.includes(typeId);
}

/** 말 뒤에 붙일 `로`/`으로`. 받침이 없거나 ㄹ이면 `로`, 나머지는 `으로`.
 *
 *  분류 이름은 사용자가 짓는 것이라(회의록·레시피·자유노트) 미리 정해 둘 수 없다.
 *  "(으)로"로 뭉개면 메뉴에 서류 냄새가 나므로 그때그때 고른다.
 *  한글이 아닌 이름(영문·숫자)은 판정할 수 없어 "(으)로"로 남긴다. */
export function josaRo(word: string): string {
  const c = word.charCodeAt(word.length - 1);
  if (Number.isNaN(c) || c < 0xac00 || c > 0xd7a3) return "(으)로";
  const jongseong = (c - 0xac00) % 28;
  // 0 = 받침 없음, 8 = ㄹ
  return jongseong === 0 || jongseong === 8 ? "로" : "으로";
}

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

/** frontmatter 값을 목록 뱃지에 쓸 한 줄로.
 *
 *  fmStr과 나누어 둔 이유는 받는 값의 폭이 다르기 때문이다 — 여기 오는 것은
 *  사용자가 자기 분류에 만든 칸이라 무엇이든 들어 있을 수 있다. 별칭 같은 목록은
 *  이어 붙이고, 위키링크는 대괄호를 걷어낸다(`[[화학]]` → `화학`). 화면에 그대로
 *  나가는 값이므로 모르는 모양(객체 등)은 빈 문자열로 흘려보낸다. */
export function fmDisplay(source: unknown, key: string): string {
  if (!source || typeof source !== "object") return "";
  const fm =
    "frontmatter" in source
      ? (source as { frontmatter: unknown }).frontmatter
      : source;
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) return "";
  const v = (fm as Record<string, unknown>)[key];
  const one = (x: unknown): string =>
    typeof x === "string"
      ? x.replace(/^\[\[|\]\]$/g, "").trim()
      : typeof x === "number"
        ? String(x)
        : "";
  if (Array.isArray(v)) return v.map(one).filter(Boolean).join(", ");
  return one(v);
}

/** 목록 줄에 값을 내보일 칸들 — 분류 정의에서 사람이 켠 것만.
 *
 *  날짜·태그는 줄이 이미 보여 주므로 켜져 있어도 뺀다. 켤 때 걸러 두긴 하지만,
 *  손으로 고친 `_types.json`이 들어와도 같은 값이 두 번 나오지는 않게 한다. */
export function listFields<F extends { name: string; in_list?: boolean }>(
  schema: { fields: F[] } | null | undefined,
): F[] {
  if (!schema) return [];
  return schema.fields.filter(
    (f) => f.in_list && f.name !== "date" && f.name !== "tags",
  );
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
  return vaultAssetSrc(vaultPath, cover);
}
