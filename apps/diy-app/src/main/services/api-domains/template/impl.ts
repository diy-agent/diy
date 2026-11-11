/**
 * api-domains/template/impl.ts —— `template` 域的 handler（从 api-impl.ts 拆出）。
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { templateApi } from "./api";

export function bindTemplate(server: ServerBinding): void {
    server.use({
        prefix: "diy",
        api: templateApi,
        // 模块层由模块自己声明（template）：与 defineService(name: "diy.template") 等价
        handlers: {
            template: {
          list: async ({ input }) => {
            const { listPrompts } = await import("../../prompt-registry");
            const { diyHome } = await import("../../../core/state");
            return listPrompts(diyHome(), input.project);
          },
          get: async ({ input }) => {
            const { getPrompt } = await import("../../prompt-registry");
            const { diyHome } = await import("../../../core/state");
            return getPrompt(diyHome(), input.project, input.relpath);
          },
          save: async ({ input }) => {
            const { savePrompt } = await import("../../prompt-registry");
            const { diyHome } = await import("../../../core/state");
            return savePrompt(diyHome(), input.project, input.relpath, input.content);
          },
          restore: async ({ input }) => {
            const { restorePrompt } = await import("../../prompt-registry");
            const { diyHome } = await import("../../../core/state");
            return restorePrompt(diyHome(), input.project, input.relpath);
          },
          preview: async ({ input }) => {
            const { assembleSystem } = await import("../../prompt-registry");
            const { diyHome, projectFromUri } = await import("../../../core/state");
            const { contextLimitOf } = await import("../../local-agent");
            const { personaForTask } = await import("../../../core/persona");
            // project 以 taskUri 为准：两者指向不同项目时（只有 CLI 能造成）system 与 tools/cwd 会错配
            const project = input.taskUri ? projectFromUri(input.taskUri) || input.project : input.project;
            const base = assembleSystem(diyHome(), project, {
              taskUri: input.taskUri,
              drafts: input.drafts,
              // 预算随预览模型变（与真发同一套推导）：显式模型优先，否则按任务当前人物
              contextLimitTokens: contextLimitOf(input.model ?? personaForTask(diyHome(), input.taskUri ?? "").model),
              // 试验场「模版结构树」要 trace；真发（local-agent）不传
              trace: true,
            });
            // 无任务场景：只渲染文本
            if (!input.taskUri) {
              return { ...base, requestBody: null, requestNote: "无任务场景：仅渲染 system 文本" };
            }
            const { previewSimulatedRequest } = await import("../../local-agent");
            const sim = await previewSimulatedRequest({ taskUri: input.taskUri, system: base.system, model: input.model });
            // ⚠️ 这条链是**模版线**（assembleSystem 渲染 _system.md + AGENTS.md 链），
            // 而真发已切到 Context Tree 投递（见 /diy.sh context lab 与 runTurn 的 buildDelivery）。
            // 所以这里造出来的 body 只是"模版渲染出来的样子"，不是真发形态 —— note 必须说清，否则误导。
            return {
              ...base,
              requestBody: sim.body,
              requestNote: `${sim.note}（注：这是**模版链**的仿真；真发已切 Context Tree 投递，见上下文树页的请求预览）`,
            };
          },
        } },
    });
}
