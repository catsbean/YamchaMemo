// 책 본문 = "## 소개\n\n{intro}\n\n## 기록\n\n{records}" — Rust template.rs와 동일 규칙

export function splitBookBody(body: string): { intro: string; records: string } {
  const introLines: string[] = [];
  const recordLines: string[] = [];
  let inRecords = false;
  for (const line of body.split("\n")) {
    if (!inRecords && line.trim() === "## 기록") {
      inRecords = true;
      continue;
    }
    if (inRecords) recordLines.push(line);
    else introLines.push(line);
  }
  let intro = introLines.join("\n").replace(/^\s+/, "");
  intro = intro.replace(/^##\s*소개\s*/, "").trim();
  const records = recordLines.join("\n").trim();
  return { intro, records };
}

export function composeBookBody(intro: string, records: string): string {
  let s = "## 소개\n\n";
  if (intro.trim()) s += `${intro.trim()}\n\n`;
  s += "## 기록\n\n";
  if (records.trim()) s += `${records.trim()}\n`;
  return s;
}
