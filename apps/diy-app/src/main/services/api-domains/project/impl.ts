/**
 * api-domains/project/impl.ts —— `project` 域的 handler
 */
import type { ServerBinding } from "@diy-agent/rpc";
import * as project from "../../../core/project";
import { projectService } from "./api";

export function bindProject(server: ServerBinding): void {
    projectService.bind(server, {
        create: async ({ input }) => {
            const id = project.createProject(input.path, {
                label: input.label,
                desc: input.desc,
                state: input.state,
            });
            return { status: "ok", data: { id } };
        },
        list: async () => {
            return { status: "ok", data: { projects: project.listProjects() } };
        },
        pick: async () => {
            // dialog 是 Electron main 专属；serve(Web) 模式无 dialog，返回 canceled
            try {
                const { dialog } = await import("electron");
                const r = await dialog.showOpenDialog({
                    title: "选择项目目录",
                    properties: ["openDirectory", "createDirectory"],
                });
                const path = r.filePaths?.[0];
                if (r.canceled || !path) {
                    return { status: "ok", data: { canceled: true } };
                }
                return { status: "ok", data: { canceled: false, path } };
            } catch (err) {
                console.error(`[pickProjectDirectory] 打开目录选择器失败: ${err}`);
                return { status: "ok", data: { canceled: true } };
            }
        },
        remove: async ({ input }) => {
            // Windows 上不暂停监听就删不掉（EPERM scandir …\projects\<id>\tasks）
            const { fileWatcher } = await import("../../file-watcher");
            await fileWatcher.pauseDuring(() => project.removeProject(input.id));
            return { status: "ok", data: { id: input.id } };
        },
    });
}
