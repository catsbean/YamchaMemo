import { useState } from "react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { commands } from "../../bindings";
import { useVault } from "../../stores/vault";
import { Section } from "./ui";

const ISSUES_URL = "https://github.com/catsbean/YamchaMemo/issues/new";

/** 켜 둔 기능 — 백엔드가 모르는 화면 설정을 진단 정보에 덧붙인다 */
function featureLine(): string {
  const s = useVault.getState();
  const on = (v: boolean) => (v ? "켬" : "끔");
  return [
    `화면 ${s.theme}`,
    `배치 ${s.layout}`,
    `첨부 검색 ${on(s.searchInFiles)}`,
    `오타 허용 ${on(s.searchFuzzy)}`,
    `빠른 담기 ${on(s.quickCaptureOn)}`,
    `할 일 탭 ${on(s.todoTabOn)}`,
    `미러 ${s.mirrors.length}곳`,
    `편집 기록 ${s.historyMax}개`,
  ].join(" · ");
}

/** 설정 › 정보 — 문제가 생기면 진단 정보를 만들어 보낸다.
 *
 *  복사하기 전에 **무엇이 담겼는지 그대로 보여 준다.** 노트 본문은 없지만 로그에 파일 경로(노트 제목)가
 *  있을 수 있어서, 보내는 사람이 보고 지울 수 있어야 한다. */
export default function DiagnosticsSection() {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function make() {
    setBusy(true);
    setCopied(false);
    const backend = await commands.diagnostics();
    // 화면 설정 줄을 최근 로그 앞에 끼운다
    const at = backend.indexOf("\n--- 최근 로그");
    const line = `설정: ${featureLine()}\n`;
    setText(at < 0 ? backend + line : backend.slice(0, at + 1) + line + backend.slice(at + 1));
    setBusy(false);
  }

  async function copy() {
    if (text == null) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function openLogs() {
    const path = await commands.logFilePath();
    if (path) await revealItemInDir(path).catch(() => {});
  }

  const btn =
    "rounded border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:border-neutral-500 disabled:opacity-50";

  return (
    <Section
      title="문제가 생기면"
      desc={
        <>
          앱이 이상하게 동작하면 진단 정보를 만들어 함께 알려 주세요. 앱 버전·vault 규모·최근
          로그가 담기고, <b className="font-medium text-neutral-600">노트 본문은 담기지 않습니다.</b>{" "}
          로그에 파일 이름(노트 제목)이 있을 수 있으니 보내기 전에 한 번 훑어보세요.
        </>
      }
    >
      <div className="flex flex-wrap gap-2">
        <button className={btn} disabled={busy} onClick={make}>
          {busy ? "만드는 중…" : text ? "다시 만들기" : "진단 정보 만들기"}
        </button>
        <button className={btn} onClick={openLogs} title="로그 파일이 있는 폴더를 탐색기로 엽니다">
          로그 폴더 열기
        </button>
        <button className={btn} onClick={() => openUrl(ISSUES_URL)} title="GitHub에 문제를 알립니다">
          문제 알리기
        </button>
      </div>
      {text != null && (
        <div className="mt-2">
          <textarea
            readOnly
            className="h-44 w-full resize-y rounded border border-neutral-200 bg-neutral-50 p-2 font-mono text-2xs leading-snug text-neutral-700"
            value={text}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="mt-1 flex items-center gap-2">
            <button
              className="rounded bg-neutral-800 px-3 py-1 text-xs text-white hover:bg-neutral-600"
              onClick={copy}
            >
              복사
            </button>
            {copied && <span className="text-xs text-emerald-600">복사했습니다</span>}
          </div>
        </div>
      )}
    </Section>
  );
}
