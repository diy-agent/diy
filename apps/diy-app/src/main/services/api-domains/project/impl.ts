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
        remove: async ({ input }) => {
            // Windows 上不暂停监听就删不掉（EPERM scandir …\projects\<id>\tasks）
            const { fileWatcher } = await import("../../file-watcher");
            await fileWatcher.pauseDuring(() => project.removeProject(input.id));
            return { status: "ok", data: { id: input.id } };
        },
    });
}
