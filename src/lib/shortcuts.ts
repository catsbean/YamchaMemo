import { useEffect, useState } from "react";
import { useVault } from "../stores/vault";

/** 맥에서는 ⌘, 그 밖에서는 Ctrl을 "주 수정키(mod)"로 쓴다 */
export const IS_MAC =
  typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.userAgent);

export interface ShortcutDef {
  id: string;
  /** 설정 화면에 보여 줄 이름 */
  label: string;
  /** 한 줄 설명 */
  hint: string;
  /** e.key 기준. 여러 개면 그중 아무거나 (예: 메뉴 이동 1~9) */
  keys: string[];
  /** ⌘ (맥) / Ctrl (윈도우) */
  mod?: boolean;
  shift?: boolean;
  /** 설정 화면에서 키 표기를 직접 정할 때 (예: "⌘1 ~ ⌘9") */
  display?: string;
}

/** 앱 전체 단축키 목록. 설정 화면도 이 목록을 그대로 보여 준다. */
export const SHORTCUTS: ShortcutDef[] = [
  {
    id: "search",
    label: "검색",
    hint: "제목·본문·태그를 한 번에 찾습니다",
    keys: ["k"],
    mod: true,
  },
  {
    id: "settings",
    label: "설정 열기",
    hint: "설정 창을 엽니다",
    keys: [","],
    mod: true,
  },
  {
    id: "newNote",
    label: "새 노트",
    hint: "지금 보고 있는 분류로 새 노트를 만듭니다",
    keys: ["n"],
    mod: true,
  },
  {
    id: "today",
    label: "오늘 일지",
    hint: "오늘 날짜의 데일리노트를 엽니다 (없으면 만듭니다)",
    keys: ["t"],
    mod: true,
  },
  {
    id: "save",
    label: "저장",
    hint: "편집 중인 노트를 바로 저장합니다",
    keys: ["s"],
    mod: true,
  },
  {
    id: "closeNote",
    label: "편집기 닫기",
    hint: "저장하고 목록으로 돌아갑니다",
    keys: ["w"],
    mod: true,
  },
  {
    id: "rawEdit",
    label: "원문 편집 전환",
    hint: "일지·독서기록에서 보기 ↔ 마크다운 원문을 오갑니다",
    keys: ["e"],
    mod: true,
  },
  {
    id: "rename",
    label: "제목 변경",
    hint: "편집 중인 노트의 제목을 고칩니다",
    keys: ["F2"],
  },
  {
    id: "nav",
    label: "메뉴 이동",
    hint: "사이드바 메뉴를 순서대로 1~9번으로 엽니다",
    keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    mod: true,
    display: IS_MAC ? "⌘1 ~ ⌘9" : "Ctrl+1 ~ Ctrl+9",
  },
];

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]));

/** 설정 화면·툴팁에 쓸 키 표기 (맥이면 ⌘⇧, 아니면 Ctrl+Shift+) */
export function shortcutText(def: ShortcutDef): string {
  if (def.display) return def.display;
  const key = def.keys[0];
  const name = key.length === 1 ? key.toUpperCase() : key;
  if (IS_MAC) return `${def.mod ? "⌘" : ""}${def.shift ? "⇧" : ""}${name}`;
  const parts = [];
  if (def.mod) parts.push("Ctrl");
  if (def.shift) parts.push("Shift");
  parts.push(name);
  return parts.join("+");
}

/** id로 키 표기 얻기 (버튼 title에 붙일 때) */
export function shortcutTextOf(id: string): string {
  const def = BY_ID.get(id);
  return def ? shortcutText(def) : "";
}

function matches(def: ShortcutDef, e: KeyboardEvent): boolean {
  // 한글 조합 중에는 키가 IME 것이다 — 동작을 일으키지 않는다
  if (e.isComposing || e.keyCode === 229) return false;
  const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!!def.mod !== mod) return false;
  if (!!def.shift !== e.shiftKey) return false;
  if (e.altKey) return false;
  return def.keys.some((k) =>
    k.length === 1 ? e.key.toLowerCase() === k : e.key === k,
  );
}

/** 단축키 하나를 window에 건다.
 *
 *  꺼 둔 단축키인지는 눌린 순간에 스토어에서 확인한다 — 설정을 바꿔도
 *  다시 구독할 필요가 없다. 핸들러는 항상 최신 것이 불린다.
 *
 *  @param id      SHORTCUTS의 id
 *  @param handler 눌렸을 때 할 일. `false`를 돌려주면 기본 동작을 막지 않는다.
 *  @param active  이 화면에서 이 단축키가 의미 있는지 (예: 편집기가 열려 있을 때만) */
export function useShortcut(
  id: string,
  handler: (key: string) => void | boolean | Promise<unknown>,
  active = true,
) {
  useEffect(() => {
    if (!active) return;
    const def = BY_ID.get(id);
    if (!def) return;
    function onKey(e: KeyboardEvent) {
      if (!matches(def!, e)) return;
      if (useVault.getState().shortcutsOff.includes(id)) return;
      if (handler(e.key) === false) return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // handler는 매 렌더 새로 만들어지지만 다시 걸 필요가 없다 —
    // ref 없이도 최신 클로저가 잡히도록 의존성에 넣는다.
  }, [id, active, handler]);
}

/** Ctrl(⌘)만 누르고 있으면 잠시 뒤 true — 단축키 목록 팝업을 띄우는 데 쓴다.
 *
 *  다른 키와 조합해 누르면(=목록을 보려는 게 아니라 단축키를 실제로 쓰려는 것)
 *  바로 꺼진다. 포커스를 잃어도(창 전환 등) keyup을 못 받을 수 있어 blur에서도 끈다. */
export function useModKeyHeld(delay = 450) {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let down = false;

    function isModKey(e: KeyboardEvent) {
      return IS_MAC ? e.key === "Meta" : e.key === "Control";
    }

    function reset() {
      down = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      setHeld(false);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.isComposing) return;
      if (isModKey(e)) {
        if (down) return; // 키 반복 이벤트
        down = true;
        timer = setTimeout(() => setHeld(true), delay);
        return;
      }
      if (down) reset(); // 조합 키를 눌렀다 = 지금은 실행이지 열람이 아니다
    }

    function onKeyUp(e: KeyboardEvent) {
      if (isModKey(e)) reset();
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", reset);
      if (timer) clearTimeout(timer);
    };
  }, [delay]);

  return held;
}

/** "새 노트" 요청을 받는다 (대시보드가 자기 만들기 창을 연다).
 *
 *  단축키는 편집기가 열려 있어도 눌리는데 만들기 창은 대시보드가 들고 있다.
 *  그래서 App이 편집기를 닫고 신호만 올리고, 그때 그려진 대시보드가 여기서 받는다. */
export function useCreateRequest(open: () => void) {
  const tick = useVault((s) => s.createTick);
  useEffect(() => {
    if (tick > 0) open();
    // open은 매 렌더 새로 만들어지므로 의존성에서 뺀다 — tick이 오를 때만 연다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
}
