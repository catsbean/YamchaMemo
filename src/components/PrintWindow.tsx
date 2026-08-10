import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PRINT_DOC_EVENT, PRINT_DOC_KEY } from "../lib/exportFile";

/** 인쇄 미리보기 전용 창.
 *
 *  본 창에 겹쳐 뜨던 미리보기를 창째로 떼어 냈다. 이 창의 X는 미리보기만 닫고,
 *  앱 창의 X는 앱만 닫는다 — 어느 쪽을 눌러야 할지 헷갈릴 일이 없다.
 *
 *  문서는 iframe에 담는다. 이 창에도 앱 스타일(styles.css)이 실려 있어서 그대로
 *  풀어 놓으면 인쇄물 스타일과 섞인다. iframe이면 문서가 제 스타일만 쓰고,
 *  인쇄도 iframe만 걸리므로 위 도구줄은 종이에 나가지 않는다. */
export default function PrintWindow() {
  const [html, setHtml] = useState(
    () => localStorage.getItem(PRINT_DOC_KEY) ?? "",
  );
  /** 같은 문서를 다시 받아도 iframe을 새로 그리게 하는 번호 (srcdoc이 같으면
   *  onLoad가 다시 오지 않아 인쇄 대화상자가 안 뜬다) */
  const [gen, setGen] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);

  // 창이 떠 있는 채로 또 인쇄를 누르면 문서만 갈아 끼운다
  useEffect(() => {
    const un = listen(PRINT_DOC_EVENT, () => {
      setHtml(localStorage.getItem(PRINT_DOC_KEY) ?? "");
      setGen((n) => n + 1);
    });
    return () => void un.then((f) => f());
  }, []);

  const print = () => frame.current?.contentWindow?.print();

  return (
    <div className="flex h-screen flex-col bg-neutral-100">
      <header className="flex items-center gap-2 border-b border-neutral-300 bg-white px-4 py-2">
        <span className="mr-auto text-sm font-bold">🖨️ 인쇄 미리보기</span>
        <button
          className="rounded bg-neutral-800 px-3 py-1 text-xs text-white hover:bg-neutral-700"
          onClick={print}
        >
          인쇄 · PDF로 저장
        </button>
        <button
          className="rounded border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:border-neutral-500"
          onClick={() => void getCurrentWindow().close()}
        >
          닫기
        </button>
      </header>

      {html ? (
        <iframe
          key={gen}
          ref={frame}
          title="인쇄할 문서"
          className="min-h-0 flex-1 border-0 bg-white"
          srcDoc={html}
          // 글꼴·이미지가 자리를 잡은 뒤에 대화상자를 띄운다
          onLoad={() => setTimeout(print, 250)}
        />
      ) : (
        <p className="mt-16 text-center text-sm text-neutral-400">
          인쇄할 문서가 없습니다.
        </p>
      )}
    </div>
  );
}
