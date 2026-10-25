// 版面骨架提供給各頁面的動作與狀態：開新增任務、開設定、目前的 Project。
// 新增任務與設定對話框由 ShellProvider 統一渲染，任何頁面都可以開啟。

import type { Project } from "@orbis/api-contract";
import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { projectsQuery } from "../../api/resources";
import { useModifierShortcut } from "../../components/hooks";
import { hasOpenLayer } from "../../components/layers";
import { persistentState, usePersistentState } from "../../lib/storage";
import type { SettingsTab } from "../settings/tabs";

const NewTaskDialog = lazy(() =>
  import("../new-task/NewTaskDialog").then((module) => ({ default: module.NewTaskDialog })),
);
const SettingsDialog = lazy(() =>
  import("../settings/SettingsDialog").then((module) => ({ default: module.SettingsDialog })),
);

export interface NewTaskInit {
  /** 預設的 Project（預設為目前的 Project）。 */
  projectId?: string;
}

export interface ShellApi {
  openNewTask: (init?: NewTaskInit) => void;
  openSettings: (tab?: SettingsTab) => void;
  /** 目前的 Project（側欄的 Task 清單、看板、新增任務的預設值）；還沒有 Project 時為 undefined。 */
  project: Project | undefined;
  projects: Project[];
  setProject: (projectId: string) => void;
}

const ShellContext = createContext<ShellApi | null>(null);

/** 上次選的 Project；不存在時用第一個。 */
export const currentProjectState = persistentState<string | null>(
  "project",
  null,
  (raw) => raw || undefined,
);

export function ShellProvider({ children }: { children: ReactNode }) {
  const { data: projects = [] } = useQuery(projectsQuery);
  const [projectId, setProjectId] = usePersistentState(currentProjectState);
  const [newTask, setNewTask] = useState<NewTaskInit | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);

  const project = projects.find((p) => p.id === projectId) ?? projects[0];

  const openNewTask = useCallback((init: NewTaskInit = {}) => setNewTask(init), []);
  const openSettings = useCallback((tab: SettingsTab = "general") => setSettingsTab(tab), []);

  // Ctrl+, 開設定（已經有對話框或選單開著時不處理）
  useModifierShortcut(",", () => {
    if (!hasOpenLayer()) setSettingsTab("general");
  });

  const api = useMemo<ShellApi>(
    () => ({ openNewTask, openSettings, project, projects, setProject: setProjectId }),
    [openNewTask, openSettings, project, projects, setProjectId],
  );

  return (
    <ShellContext.Provider value={api}>
      {children}
      <Suspense fallback={null}>
        {newTask && (
          <NewTaskDialog
            projectId={newTask.projectId ?? project?.id}
            onClose={() => setNewTask(null)}
          />
        )}
        {settingsTab && (
          <SettingsDialog
            tab={settingsTab}
            onTabChange={setSettingsTab}
            onClose={() => setSettingsTab(null)}
          />
        )}
      </Suspense>
    </ShellContext.Provider>
  );
}

export function useShell(): ShellApi {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell 必須在 ShellProvider 底下使用");
  return shell;
}
