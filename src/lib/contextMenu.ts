import { useEffect, useState } from "react";

/** 우클릭 메뉴 항목. `separator: true`면 구분선. */
export interface MenuItem {
  label?: string;
  hint?: string;
  onClick?: () => void;
  disabled?: boolean;
  separator?: boolean;
  danger?: boolean;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/**
 * 웹뷰 기본 컨텍스트 메뉴(뒤로 가기·새로고침·검사 등)를 전역에서 막는다.
 * 데스크톱 앱에 브라우저 메뉴가 뜨면 앱처럼 보이지 않고, 사용자가 쓸 항목도 없다.
 * 개발 중에는 검사 메뉴가 필요하므로 dev 빌드에서는 막지 않는다.
 */
export function useSuppressNativeContextMenu() {
  useEffect(() => {
    // 개발 중에는 웹뷰 검사 메뉴가 필요해서 그대로 둔다
    if (import.meta.env.DEV) return;
    function onContextMenu(e: MouseEvent) {
      // 우리 메뉴를 띄우는 쪽에서 이미 preventDefault 했다면 그대로 둔다
      if (e.defaultPrevented) return;
      e.preventDefault();
    }
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);
}

/** 우클릭 메뉴 열기/닫기 상태를 다루는 훅 */
export function useContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);

  function open(e: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]) {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  return { menu, open, close: () => setMenu(null) };
}

/**
 * 노트 항목에 붙이는 공통 동작:
 * - Ctrl(⌘)+클릭 또는 가운데 버튼 클릭 → 새 창
 * - 우클릭 → 메뉴
 * 를 한 번에 만들어 준다.
 */
export function noteItemHandlers(
  relPath: string,
  openHere: () => void,
  openWindow: (rel: string) => void,
  showMenu: (
    e: { clientX: number; clientY: number; preventDefault(): void },
    items: MenuItem[],
  ) => void,
  extraItems: MenuItem[] = [],
) {
  return {
    onClick: (e: React.MouseEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        openWindow(relPath);
      } else {
        openHere();
      }
    },
    onAuxClick: (e: React.MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        openWindow(relPath);
      }
    },
    onContextMenu: (e: React.MouseEvent) => {
      showMenu(e, [
        { label: "열기", onClick: openHere },
        {
          label: "새 창으로 열기",
          hint: "Ctrl+클릭",
          onClick: () => openWindow(relPath),
        },
        ...extraItems,
      ]);
    },
  };
}
