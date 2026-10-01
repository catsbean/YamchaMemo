// CHANGELOG.md에서 한 판의 절을 뽑는다 — 릴리스 설명과 앱의 업데이트 창(latest.json의 notes)에 실린다.
//
//   node scripts/changelog.mjs section 0.7.1   → 그 절의 본문을 출력 (없거나 비면 실패)
//
// release.bat은 태그를 찍기 전에 이것으로 절이 있는지 확인하고(빈 설명으로 내보내지 않게),
// release.yml은 태그의 절을 뽑아 tauri-action의 releaseBody로 넘긴다. 업데이트 창의 설명은
// **빌드할 때** 정해진다 — Publish 전에 릴리스 설명을 고쳐도 latest.json에는 안 들어간다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `## 0.7.1` (뒤에 `— 2026-10-02` 같은 꼬리가 붙어도 된다)부터 다음 `## `까지의 본문 → 없으면 null */
export function sectionOf(markdown, version) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const escaped = version.replace(/\./g, "\\.");
  const head = new RegExp(`^##\\s+v?${escaped}(?![\\d.])`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body || null;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [cmd, version] = process.argv.slice(2);
  if (cmd !== "section" || !version) {
    console.error("사용법: node scripts/changelog.mjs section <x.y.z>");
    process.exit(2);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const body = sectionOf(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version);
  if (!body) {
    console.error(`CHANGELOG.md에 "## ${version}" 절이 없거나 비어 있습니다.`);
    process.exit(1);
  }
  process.stdout.write(body + "\n");
}
