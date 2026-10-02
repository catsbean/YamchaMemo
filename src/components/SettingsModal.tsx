import { useState, type ReactNode } from "react";
import HelpSection from "./HelpSection";
import Modal from "./Modal";
import BackupSection from "./settings/BackupSection";
import BookPickerSection from "./settings/BookPickerSection";
import CalloutSection from "./settings/CalloutSection";
import CustomTypesSection from "./settings/CustomTypesSection";
import DailyKindOrderSection from "./settings/DailyKindOrderSection";
import DeleteConfirmSection from "./settings/DeleteConfirmSection";
import DiagnosticsSection from "./settings/DiagnosticsSection";
import HistorySection from "./settings/HistorySection";
import KakaoSection from "./settings/KakaoSection";
import LayoutSection from "./settings/LayoutSection";
import LinkSection from "./settings/LinkSection";
import MirrorSection from "./settings/MirrorSection";
import NoteTemplateSection from "./settings/NoteTemplateSection";
import QuickCaptureSection from "./settings/QuickCaptureSection";
import ScrapTypeSection from "./settings/ScrapTypeSection";
import ShortcutSection from "./settings/ShortcutSection";
import StartupSection from "./settings/StartupSection";
import ThemeSection from "./settings/ThemeSection";
import TodoTabSection from "./settings/TodoTabSection";
import TrashSection from "./settings/TrashSection";
import VaultSection from "./settings/VaultSection";
import VersionSection from "./settings/VersionSection";

/** 잠그는 섹션(재색인·백업)이 창에 알리는 손잡이 */
type Lock = { setReindexing: (b: boolean) => void; setBackupBusy: (b: boolean) => void };

/** 설정 메뉴 — **무엇이 어디 있는지는 이 배열 하나가 정한다** (8-5).
 *
 *  "무엇을 하려는가"로 묶는다. 예전엔 손이 가는 대로 쌓여 "일반" 탭 하나에 11개가 있었고 버전은 그
 *  맨 아래에 묻혀 있었다. 새 설정을 만들지 않았다 — 옮기고 모양만 맞췄다(저장 키는 그대로). */
export const SETTINGS_MENU: { id: string; label: string; icon: string; render: (lock: Lock) => ReactNode }[] = [
  {
    id: "screen",
    label: "화면",
    icon: "🌓",
    render: () => (
      <>
        <ThemeSection />
        <StartupSection />
        <LayoutSection />
        <TodoTabSection />
        <BookPickerSection />
      </>
    ),
  },
  {
    id: "write",
    label: "쓰기",
    icon: "✏️",
    render: () => (
      <>
        <CalloutSection />
        <DailyKindOrderSection />
        <NoteTemplateSection />
        <LinkSection />
        <DeleteConfirmSection />
      </>
    ),
  },
  {
    id: "types",
    label: "분류",
    icon: "🗂️",
    render: () => <TypesMenu />,
  },
  {
    id: "capture",
    label: "단축키·담기",
    icon: "⌨️",
    render: () => (
      <>
        <QuickCaptureSection />
        <ScrapTypeSection />
        <ShortcutSection />
      </>
    ),
  },
  {
    id: "storage",
    label: "저장",
    icon: "💾",
    render: (lock) => (
      <>
        <VaultSection onBusy={lock.setReindexing} />
        <BackupSection onBusy={lock.setBackupBusy} />
        <MirrorSection />
        <TrashSection />
        <HistorySection />
      </>
    ),
  },
  {
    id: "links",
    label: "연동",
    icon: "🔌",
    render: () => <KakaoSection />,
  },
  {
    id: "about",
    label: "정보",
    icon: "ℹ️",
    render: () => (
      <>
        <VersionSection />
        <DiagnosticsSection />
        <div className="pt-4">
          <HelpSection />
        </div>
      </>
    ),
  },
];

/** 사용자 분류가 하나도 없을 때도 메뉴가 비어 보이지 않게 */
function TypesMenu() {
  return (
    <>
      <CustomTypesSection />
      <p className="py-4 text-xs leading-relaxed text-neutral-500">
        나만의 분류(예: 회의록, 레시피)는 왼쪽 메뉴 아래의 <b className="font-medium">[+ 분류 추가]</b>로
        만듭니다. 만든 분류는 여기서 목록에 보일 칸과 새 노트 템플릿을 고치거나 지울 수 있습니다.
      </p>
    </>
  );
}

const LAST_MENU_KEY = "yamcha.settingsMenu";

function lastMenu(): string {
  try {
    const v = localStorage.getItem(LAST_MENU_KEY);
    if (v && SETTINGS_MENU.some((m) => m.id === v)) return v;
  } catch {
    // 저장소를 못 쓰면 첫 메뉴부터
  }
  return SETTINGS_MENU[0].id;
}

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  // 마지막으로 연 메뉴를 기억한다 — 이 창(기기)만의 편의라 설정 파일이 아니라 브라우저 저장소에
  const [menu, setMenu] = useState<string>(lastMenu);
  // 재색인·백업·복원이 도는 동안엔 창을 닫지 못한다 (진행과 결과를 볼 곳이 여기뿐이다)
  const [reindexing, setReindexing] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const current = SETTINGS_MENU.find((m) => m.id === menu) ?? SETTINGS_MENU[0];

  function pick(id: string) {
    setMenu(id);
    try {
      localStorage.setItem(LAST_MENU_KEY, id);
    } catch {
      // 기억하지 못해도 동작은 같다
    }
  }

  return (
    <Modal
      onClose={onClose}
      locked={reindexing || backupBusy}
      panelClassName="flex h-[40rem] max-h-[90vh] w-[46rem] max-w-[94vw] flex-col overflow-hidden rounded-lg shadow-xl"
    >
      <div className="flex min-h-0 flex-1">
        <nav
          className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-neutral-200 bg-neutral-50 p-3"
          aria-label="설정 메뉴"
        >
          <h2 className="mb-2 px-2 text-base font-bold">설정</h2>
          {SETTINGS_MENU.map((m) => (
            <button
              key={m.id}
              type="button"
              aria-current={m.id === current.id ? "page" : undefined}
              className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ${
                m.id === current.id
                  ? "bg-white font-medium text-neutral-900 shadow-sm"
                  : "text-neutral-600 hover:bg-neutral-100"
              }`}
              onClick={() => pick(m.id)}
            >
              <span aria-hidden>{m.icon}</span>
              {m.label}
            </button>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-4">
          {current.render({ setReindexing, setBackupBusy })}
        </div>
      </div>
      <div className="flex justify-end border-t border-neutral-100 px-5 py-3">
        <button
          className="rounded bg-neutral-800 px-4 py-1.5 text-sm text-white hover:bg-neutral-600"
          onClick={onClose}
        >
          닫기
        </button>
      </div>
    </Modal>
  );
}
