import { useState } from "react";
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

const TABS = [
  { id: "general", label: "일반" },
  { id: "record", label: "기록" },
  { id: "storage", label: "저장" },
  { id: "etc", label: "연동" },
  { id: "help", label: "도움말" },
] as const;

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<string>("general");
  // 재색인·백업·복원이 도는 동안엔 창을 닫지 못한다 (진행과 결과를 볼 곳이 여기뿐이다)
  const [reindexing, setReindexing] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);

  return (
    <Modal
      onClose={onClose}
      locked={reindexing || backupBusy}
      panelClassName="flex h-[38rem] max-h-[88vh] w-[32rem] flex-col rounded-lg p-5 shadow-xl"
    >
        <h2 className="mb-3 text-base font-bold">설정</h2>
        <div className="mb-4 flex gap-1 border-b border-neutral-200">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
                tab === t.id
                  ? "border-neutral-800 font-medium text-neutral-800"
                  : "border-transparent text-neutral-400 hover:text-neutral-600"
              }`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1">
        {tab === "general" && (
          <>
        <ThemeSection />
        <StartupSection />
        <TodoTabSection />
        <LayoutSection />
        <BookPickerSection />
        <LinkSection />
        <ShortcutSection />
        <QuickCaptureSection />
        <ScrapTypeSection />
        <DeleteConfirmSection />
        <VersionSection />
          </>
        )}

        {tab === "record" && (
          <>
        <CalloutSection />
        <DailyKindOrderSection />
        <NoteTemplateSection />

        <CustomTypesSection />
          </>
        )}

        {tab === "storage" && (
          <>
        <VaultSection onBusy={setReindexing} />
        <MirrorSection />
        <BackupSection onBusy={setBackupBusy} />
        <TrashSection />
        <HistorySection />
          </>
        )}

        {tab === "etc" && <KakaoSection />}

        {tab === "help" && (
          <>
            <DiagnosticsSection />
            <HelpSection />
          </>
        )}

        </div>

        <div className="flex justify-end border-t border-neutral-100 pt-3">
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

