// 릴리스 버전을 package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml
// 세 곳에 동시에 반영한다. scripts/release.bat에서 호출된다.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const newVersion = process.argv[2];

if (!newVersion || !/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error("사용법: node scripts/bump-version.mjs <x.y.z>");
  process.exit(1);
}

function replaceOnce(relPath, pattern, replacement) {
  const fullPath = join(root, relPath);
  const text = readFileSync(fullPath, "utf8");
  if (!pattern.test(text)) {
    throw new Error(`${relPath}에서 버전 문자열을 찾지 못했습니다.`);
  }
  writeFileSync(fullPath, text.replace(pattern, replacement), "utf8");
}

replaceOnce("package.json", /"version": "[^"]+"/, `"version": "${newVersion}"`);
replaceOnce(
  "src-tauri/tauri.conf.json",
  /"version": "[^"]+"/,
  `"version": "${newVersion}"`,
);
replaceOnce(
  "src-tauri/Cargo.toml",
  /^version = "[^"]+"/m,
  `version = "${newVersion}"`,
);

console.log(`버전을 ${newVersion}(으)로 올렸습니다.`);
