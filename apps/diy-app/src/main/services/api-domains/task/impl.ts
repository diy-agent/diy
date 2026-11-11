/**
 * api-domains/task/impl.ts —— `task` 域的 handler
 *
 * 从 api-impl.ts 按**行号**切出（不依赖注释分组、不算字符偏移）。
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { resolve as resolvePath, relative as relativePath, isAbsolute as isAbsolutePath } from "node:path";
import * as project from "../../../core/project";
import type { DraftField } from "../../../core/drafts";
import { TaskDetailSchema } from "../../../../shared/task-detail";
import * as taskTree from "../../../core/task-tree";
import { hasConversation } from "../../../core/local-paths";
import { taskApi } from "./api";
import { writeDrafts, readDrafts, clearDrafts, DRAFT_FIELDS } from "../../../core/drafts";
import * as state from "../../../core/state";

import * as task from "../../../core/task";

  /**
   * 找 **cwd 属于哪个项目**（##430）。
   *
   * 多个项目可以**互相嵌套**（实测数据根里同时注册了 `~/git/diy` 与 `~/git/diy/diy`），
   * 所以「包含 cwd」的项目可能不止一个 —— 取**最深的那个**（路径最长）作为语义归属：
   * 人在 `~/git/diy/diy`（或其 worktree）里敲命令，归属就是代码仓本身，不是它的父目录。
   */
function projectOwningCwd(cwd: string): { id: string; path: string; label?: string } | undefined {
    const target = resolvePath(cwd);
    let best: { id: string; path: string; label?: string } | undefined;
    for (const { id, info } of project.listProjects()) {
      const root = project.getProjectPath(id);
      if (!root) continue;
      const rel = relativePath(root, target);
      // rel === "" → 就在项目根；不以 .. 开头且非绝对 → 在其子目录（worktree 天然成立）
      if (rel !== "" && (rel.startsWith("..") || isAbsolutePath(rel))) continue;
      if (!best || root.length > best.path.length) best = { id, path: root, label: info.label };
    }
    return best;
  }

export function bindTask(server: ServerBinding): void {
    server.use({
        prefix: "diy",
        api: taskApi,
        // 模块层由模块自己声明（task）：与 defineService(name: "diy.task") 等价
        handlers: {
            task: {
            create: async ({ input }) => {
            // 正文输入的显式三态（##338 / ##376）：`body|bodyText|bodyFile` 三选一 —— 与 `task edit`
            // 同一裁决点（core/task.ts::resolveBodyOverride），免得"某条命令漏了护栏"再次发生。
            // `cwd` / `force` 不是任务字段：cwd 由 CLI parser 自动注入（归属检测用），force 是逃生口。
            const { body, bodyText, bodyFile, cwd, force, ...rest } = input;
    
            // 归属检测（##430）：人在某个项目的目录里（或其 worktree 里），却给**另一个** project ——
            // 实际踩过：在 `~/git/diy/diy` 的 worktree 里把 ##92/93/94 建到了父目录项目 2，
            // 两个项目各自有 tasks/92，同号撞车，事后靠两轮对话才纠正。
            // 口径：**只拒绝、不猜**（猜错比报错贵）。要给别的项目建任务 → 显式换 --project，或加 --force。
            if (!force && cwd) {
              const owner = projectOwningCwd(cwd);
              if (owner && owner.id !== rest.project) {
                const cand = project
                  .listProjects()
                  .map(({ id, info }) => `  ${id} · ${info.label ?? "(无 label)"} · ${info.path ?? "(无 path)"}`)
                  .join("\n");
                throw new task.ValidationError([
                  {
                    field: "project",
                    code: "project-mismatch",
                    msg:
                      `cwd 属于 project ${owner.id}（${owner.label ?? "无 label"} · ${owner.path}），` +
                      `但给的是 project ${rest.project} —— 层号/路径不符，拒绝创建（免得多项目同号任务撞车）。\n` +
                      `候选项目：\n${cand}\n` +
                      `下一步：把 project 改成 ${owner.id}；确要在 ${rest.project} 下建则加 --force。`,
                  },
                ]);
              }
            }
    
            const resolvedBody = task.resolveBodyOverride({ body, bodyText, bodyFile });
            const uri = task.createTask({ ...rest, body: resolvedBody } as any);
            // 归属回显（##430）：只回 uri 时人看不出落到了哪个仓，故带上 label / path
            const info = project.getProjectInfo(rest.project);
            return { status: "ok", data: { uri, project: rest.project, label: info?.label, path: info?.path } };
            },
            list: async ({ input }) => {
            const tasks = task.listTasks(input.project);
            // 多项目同号可分辨（##430）：`tasks` 仍是 uri 字符串数组（形状不变），
            // 归属另给一张 id → label/path 的表 —— 只有 id 时 `projects/2/tasks/92` 与
            // `projects/4/tasks/92` 脱离上下文看不出是哪个仓。
            const ids = new Set(tasks.map((u) => u.split("/")[1]));
            const projects = project
              .listProjects()
              .filter(({ id }) => ids.has(id))
              .map(({ id, info }) => ({ id, label: info.label, path: info.path }));
            return { status: "ok", data: { tasks, projects } };
            },
            show: async ({ input }) => {
            const t = state.getTask(input.uri);
            if (!t) return { status: "error", msg: `任务 ${input.uri} 不存在` };
            // project 只存 id；同时回填 path/label，CLI 才看得到原 subject 路径
            const info = project.getProjectInfo(t.project ?? "");
            // 草稿随任务一并返回：renderer 少一次往返即拿到恢复所需的一切
            const d = readDrafts(input.uri);
            return {
              status: "ok",
              data: {
                ...t,
                project_path: info?.path,
                project_label: info?.label,
                ui_drafts: d ? { base_updated: d.base_updated, saved: d.saved, fields: d.fields } : null,
              },
            };
            },
            tree: async () => ({ status: "ok", data: taskTree.loadTaskTree() }),
            detail: async ({ input }) => {
                const t = state.getTask(input.uri);
                // 未找到 → data: null（truthy 的壳对象会让 renderer 守卫失效）
                if (!t) return { status: "error", data: null };
                const pinfo = project.getProjectInfo(t.project ?? "");
                const d = readDrafts(input.uri);
                // **整份交给契约 schema**：形状由 shared/task-detail.ts 的 TaskDetailSchema（单一真源）决定，
                // 多余键自动剥掉。历史教训：handler 与 output 各抄一份键清单，漏一处就静默丢字段。
                return {
                    status: "ok",
                    data: TaskDetailSchema.parse({
                        ...t,
                        project_path: pinfo?.path,
                        project_label: pinfo?.label,
                        ui_drafts: d ? { base_updated: d.base_updated, saved: d.saved, fields: d.fields } : null,
                        has_session: hasConversation(input.uri),
                        has_draft: d?.fields?.agent_input !== undefined,
                    }),
                };
            },
            edit: async ({ input }) => {
            // 正文输入的显式三态（##338）：`body|bodyText|bodyFile`、`appendBody|appendBodyFile|appendBodyText`
            // 各自三选一 —— 求值收敛在 core（`resolveBodyInputs`），此处只负责把这两组从普通字段里摘出来。
            const { uri, body, bodyText, bodyFile, appendBody, appendBodyFile, appendBodyText, ...changes } = input;
            const bodyInputs = task.resolveBodyInputs({ body, bodyText, bodyFile, appendBody, appendBodyFile, appendBodyText });
            const filtered: Record<string, string> = {};
            for (const [k, v] of Object.entries(changes)) {
              if (v !== undefined) filtered[k] = v as string;
            }
            // 回报本次写入实际做了什么（剥头 / 追加）—— CLI 侧才有话可说，见 core/task.ts 的 TaskWriteReport
            const report = task.updateTask(uri, { ...filtered, ...bodyInputs } as task.UpdateTaskChanges);
            return { status: "ok", data: { uri, ...report } };
            },
            move: async ({ input }) => {
            task.moveTask(input.uri, input.parent);
            return { status: "ok", data: { uri: input.uri } };
            },
            delete: async ({ input }) => {
            // 草稿在任务目录 .diy/ 内，随整体删目录一并删除，无需单独清理。
            // 删之前**暂停文件监听**：chokidar 在 Windows 上对被删目录持有句柄 ⇒ EPERM（见 file-watcher.pauseDuring）
            const { fileWatcher } = await import("../../file-watcher");
            await fileWatcher.pauseDuring(() => task.deleteTask(input.uri));
            return { status: "ok", data: { uri: input.uri } };
            },
            drafts: {
            show: async ({ input }) => {
            const d = readDrafts(input.uri);
            return { status: "ok", data: d ? { base_updated: d.base_updated, saved: d.saved, fields: d.fields } : null };
            },
            set: async ({ input }) => {
            // undefined = 未提供（保持原值）；"" = 清除该字段 —— 由 writeDrafts 的 splitFields 落地
            const { uri, base_updated, body, bodyText, bodyFile, ...rest } = input;
            const fields: Partial<Record<DraftField, string>> = {};
            for (const f of DRAFT_FIELDS) {
              const v = (rest as Record<string, string | undefined>)[f];
              if (v !== undefined) fields[f] = v;
            }
            // 正文草稿的显式三态（##376）：`--body` / `--body-text` / `--body-file` 三选一，
            // 与 `task edit` 同一裁决点；三态都未给 = 不动该字段（与其它字段的"不传=保持"一致）。
            const bodyDraft = task.resolveBodyOverride({ body, bodyText, bodyFile });
            if (bodyDraft !== undefined) fields.body = bodyDraft;
            const r = writeDrafts(uri, fields, base_updated);
            return { status: "ok", data: { base_updated: r.base_updated, saved: r.saved, fields: r.fields } };
            },
            clear: async ({ input }) => {
                clearDrafts(input.uri, input.fields as DraftField[] | undefined);
                return { status: "ok" };
            },
            },
        } },
    });
}
