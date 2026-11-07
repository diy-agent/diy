/**
 * api-domains/llmConfig/impl.ts —— `llmConfig` 域的 handler（从 api-impl.ts 拆出）。
 */
import type { ServerBinding } from "@diy-agent/rpc";
import { llmConfigService } from "./api";
import { refreshModelRuntime } from "../../../core/model-runtime";
import * as state from "../../../core/state";
import { traffic } from "../../../core/traffic";

export function bindLlmConfig(server: ServerBinding): void {
    llmConfigService.bind(server, {
      read: async () => {
        const { registryView } = await import("../../../core/model-registry");
        try {
          return registryView(state.diyHome());
        } catch (e) {
          // 配置坏文件（结构非法）不该让 UI 锁死：返回空视图 + error，页面仍能打开提示（##275 R1-6）
          return {
            modelFile: { stdProviders: {}, customProviders: {} },
            customSpecs: {},
            catalog: [],
            providers: [],
            calendars: [],
            windows: [],
            error: e instanceof Error ? e.message : String(e),
          };
        }
      },
      write: async ({ input }) => {
        const { saveModelConfig } = await import("../../../core/model-config");
        saveModelConfig(state.diyHome(), input.modelFile);
        refreshModelRuntime(state.diyHome());
        return { status: "ok" };
      },
      writeSpec: async ({ input }) => {
        const { loadCustomSpecs, saveCustomSpecs } = await import("../../../core/model-config");
        const specs = loadCustomSpecs(state.diyHome());
        if (input.spec === null) delete specs[input.id];
        else specs[input.id] = input.spec;
        saveCustomSpecs(state.diyHome(), specs);
        refreshModelRuntime(state.diyHome());
        return { status: "ok" };
      },

      /**
       * 模型目录刷新（##385）：手工按钮（模型页 / 模型不可用 bar）入口。
       * 与定时任务共用 `refreshAndApply` —— 写盘 + 让进程内快照缓存失效 + 重装运行时目录。
       * **不抛**：失败进返回值（ok=false + error），UI 直接渲染三态。
       */
      syncModels: async () => {
        const { refreshAndApply } = await import("../../../core/models-sync");
        return refreshAndApply({ home: state.diyHome() });
      },

      costs: async ({ input }) => {
        const { providerCosts } = await import("../../../core/llm-cost");
        return providerCosts(state.diyHome(), input.provider);
      },
      // 价目写入后立刻重装运行时目录（与 write / writeSpec 同一处收敛）：改价即生效，
      // 不必等下次 provider 配置改动才被读到。
      setCost: async ({ input }) => {
        const { setModelCost } = await import("../../../core/llm-cost");
        const result = setModelCost(state.diyHome(), input);
        refreshModelRuntime(state.diyHome());
        return result;
      },
      setTiers: async ({ input }) => {
        const { setModelTiers } = await import("../../../core/llm-cost");
        const result = setModelTiers(state.diyHome(), input);
        refreshModelRuntime(state.diyHome());
        return result;
      },
      scanEnv: async () => {
        const { scanEnv } = await import("../../../core/model-import");
        // 连同扫描面（provider 数 / 变量名）一起回报：零命中时 UI 要能说清「查过什么」
        return scanEnv(state.diyHome());
      },
      importEnv: async ({ input }) => {
        const { importEnvProviders } = await import("../../../core/model-import");
        const r = importEnvProviders(state.diyHome(), input.providers);
        // 落盘后立即重装运行时目录（与 write/writeSpec 同一约定：改配置即刻生效）
        if (r.imported.length > 0) refreshModelRuntime(state.diyHome());
        return r;
      },

      probe: async ({ input }) => {
        // 拉 `${baseUrl}/models`：既是连通性测试，也是 custom provider 的模型清单来源。
        // 不强求成功：上游若不支持 /models（如 commandcode），ok=false 且 error 说明原因。
        const { expandEnvValue } = await import("../../../core/model-registry");
        if (input.apiKey.trim() === "") return { ok: false, status: null, models: [], error: "账号密钥为空" };
        const expanded = expandEnvValue(input.apiKey);
        if (expanded.error || expanded.value === null) {
          return { ok: false, status: null, models: [], error: expanded.error ?? "密钥为空" };
        }
        const base = input.baseUrl.replace(/\/+$/, "");
        traffic.noteProbe(base); // 让流量页能标注「模型配置探测」来源
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12_000);
        try {
          const res = await fetch(`${base}/models`, {
            headers: expanded.value ? { authorization: `Bearer ${expanded.value}` } : {},
            signal: ctrl.signal,
          });
          const text = await res.text();
          if (!res.ok) {
            return { ok: false, status: res.status, models: [], error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
          }
          let models: { id: string; name: string | null; context: number | null; endpoints: string[] }[] = [];
          try {
            const json = JSON.parse(text) as {
              data?: Array<{ id?: string; name?: string; context_length?: number; supported_endpoints?: string[] }>;
            };
            models = (json.data ?? [])
              .filter((m) => typeof m?.id === "string")
              .map((m) => ({
                id: m.id as string,
                name: m.name ?? null,
                context: typeof m.context_length === "number" ? m.context_length : null,
                endpoints: Array.isArray(m.supported_endpoints) ? m.supported_endpoints.filter((e) => typeof e === "string") : [],
              }));
          } catch {
            return { ok: false, status: res.status, models: [], error: "响应不是 JSON（/models 不可解析）" };
          }
          return { ok: true, status: res.status, models, error: null };
        } catch (e) {
          return { ok: false, status: null, models: [], error: e instanceof Error ? e.message : String(e) };
        } finally {
          clearTimeout(timer);
        }
      },
    });
}
