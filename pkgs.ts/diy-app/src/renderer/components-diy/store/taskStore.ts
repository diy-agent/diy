// src/renderer/store/taskStore.ts

import { create } from "zustand";
import { diyService } from "../lib/rpc";

export interface TreeNode {
  kind: "subject" | "task";
  uri?: string;
  title?: string;
  state?: string;
  subjectPath?: string;
  parentUri?: string;
  starred: boolean;
  children: TreeNode[];
}

interface TaskStore {
  nodes: TreeNode[];
  selectedUri: string | null;
  selectedTask: Record<string, unknown> | null;
  loading: boolean;
  loadTree: () => Promise<void>;
  selectTask: (uri: string | null) => Promise<void>;
}

export const useTaskStore = create<TaskStore>((set, _get) => ({
  nodes: [],
  selectedUri: null,
  selectedTask: null,
  loading: false,

  loadTree: async () => {
    set({ loading: true });
    try {
      const nodes = (await diyService.diy.app.loadTaskTree({ allTasks: true })) as TreeNode[];
      set({ nodes, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  selectTask: async (uri: string | null) => {
    set({ selectedUri: uri, selectedTask: null });
    if (!uri) return;
    const task = (await diyService.diy.app.getTask({ uri })) as Record<string, unknown> | null;
    if (task) set({ selectedTask: task });
  },
}));
