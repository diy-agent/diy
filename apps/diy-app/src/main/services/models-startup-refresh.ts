// src/main/services/models-startup-refresh.ts
// 🎯 模型目录的**启动后一次**刷新（##385 §3.2 的一半）：后台跑、不阻塞启动、有 diff 才写。
//
// 为什么只做「一次」而不做定时：**调度归 ##408**（全局 job 调度器 + 可见性正在那儿设计）。
// 本条只留干净的函数边界 ——
//   · `core/models-sync.ts::refreshModelsOnce` = **一次 tick**（抓 → 校验 → 有 diff 才写），
//     纯依赖注入、无定时器、无全局状态 ⇒ ##408 的调度器直接调它即可；
//   · 本文件 = 启动时**叫一次** tick（延迟到窗口出来之后），应用退出时清掉挂着的定时器。
// 到了 ##408 接管时，本文件应整体删除（启动首跑由调度器的一次性 job 表达）。
//
// 硬约束（与 §3.2 一致）：
//   · 后台跑，**不阻塞启动**（首跑延迟 startupDelayMs，默认 15s —— 让窗口先出来）；
//   · 失败不弹窗轰炸：只写一条 warn 日志；界面要看得见的是**状态**（模型页 / bar），不是 toast；
//   · 无 diff 不写盘（判据在 core/models-sync.ts，不在本文件重复）。
import type { ModelsRefreshResult } from "../../shared/model-config";
import { refreshAndApply } from "../core/models-sync";
import { diyHome } from "../core/state";

/** 首跑延迟：先让窗口 / RPC 起来，别把启动挤在一起 */
export const DEFAULT_STARTUP_DELAY_MS = 15_000;

/**
 * 环境变量（`DIY_*` 契约；与 `main/index.ts` 头注同一族）：
 *   · `DIY_MODELS_STARTUP_REFRESH=0|false|off` → 关（缺省开；手工按钮不受影响）
 *   · `DIY_MODELS_SYNC_STARTUP_DELAY_MS=<ms>` → 首跑延迟（缺省 15s；测试 / 调试可设 0）
 *   · `DIY_MODELS_DEV_ORIGIN=<url|路径>` → 抓取源（缺省官方 api.json；离线 / 测试用）
 *
 * 为什么是环境变量而不是 model.yaml：配置文件由模型页**整份回写**（`llmConfig.write`），
 * 没被 UI 认识的键会被 schema 剥掉 —— 放进去等于「用户编辑保存一次就丢」。开关的 UI 归 ##408。
 */
export function startupRefreshEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = (env["DIY_MODELS_STARTUP_REFRESH"] ?? "").trim().toLowerCase();
    return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

/** 定时器面（**依赖注入**：单测不 sleep 15s） */
export interface StartupTimer {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

const realTimer: StartupTimer = {
    setTimeout: (fn, ms) => {
        const h = setTimeout(fn, ms);
        // 定时刷新不该拖住进程退出
        (h as { unref?: () => void }).unref?.();
        return h;
    },
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface StartupRefreshDeps {
    /** 一次刷新（缺省 `refreshAndApply`：写盘 + 让进程内缓存失效 + 重装运行时目录） */
    refresh?: () => Promise<ModelsRefreshResult>;
    /** 关掉（缺省看 `DIY_MODELS_STARTUP_REFRESH`） */
    enabled?: boolean;
    /** 首跑延迟（缺省 `DIY_MODELS_SYNC_STARTUP_DELAY_MS` / 15s） */
    delayMs?: number;
    timer?: StartupTimer;
    /** 结果回调（日志 / 状态展示）；失败也回调 —— 由它决定「出声」到什么程度 */
    onResult?: (r: ModelsRefreshResult) => void;
    log?: (msg: string) => void;
    warn?: (msg: string) => void;
}

/**
 * 注册启动后一次刷新；返回取消函数（应用退出 / 测试 teardown 调）。
 *
 * 失败语义：单轮失败只记一行 warn，**不重试**（24h 级别的频率下重试没有意义；手工按钮随时可点）。
 */
export function refreshModelsOnStartup(deps: StartupRefreshDeps = {}): () => void {
    const timer = deps.timer ?? realTimer;
    const log = deps.log ?? ((m) => console.log(m));
    const warn = deps.warn ?? ((m) => console.warn(m));
    const enabled = deps.enabled ?? startupRefreshEnabled();
    const delay = deps.delayMs ?? Number(process.env["DIY_MODELS_SYNC_STARTUP_DELAY_MS"] ?? DEFAULT_STARTUP_DELAY_MS);
    const refresh = deps.refresh ?? (() => refreshAndApply({ home: diyHome() }));

    if (!enabled) {
        log("[models-sync] 启动刷新已关闭（DIY_MODELS_STARTUP_REFRESH）—— 手工按钮仍可用");
        return () => {};
    }

    let cancelled = false;
    // `run` 必须在 `setTimeout` **之前**声明：同步触发的 fake timer（单测）会在事件循环之前就调用它，
    // 声明在后面 = 命中 TDZ 的 ReferenceError（真 timer 侥幸没事，纯属调度延迟掩盖）。
    const run = async (): Promise<void> => {
        if (cancelled) return;
        try {
            const r = await refresh();
            deps.onResult?.(r);
            if (cancelled) return; // 退出途中拿到的结果不再说话（日志已经没人看了）
            if (!r.ok) {
                warn(`[models-sync] 启动刷新失败（保留旧快照）：${r.error ?? "未知原因"}`);
            } else if (r.changed) {
                log(
                    `[models-sync] 启动刷新已更新：新增 ${r.addedModels} 个模型 / 下线 ${r.removedModels} 个（${r.providers} providers · ${r.models} models）→ ${r.path}`,
                );
            } else {
                log(`[models-sync] 启动刷新：已是最新（${r.providers} providers · ${r.models} models）`);
            }
        } catch (e) {
            // refresh 契约是「永不抛」，但定时器不该因为任何意外挂掉
            warn(`[models-sync] 启动刷新异常（忽略）：${e instanceof Error ? e.message : String(e)}`);
        }
    };

    const handle = timer.setTimeout(
        () => void run(),
        Math.max(0, Number.isFinite(delay) ? delay : DEFAULT_STARTUP_DELAY_MS),
    );

    return () => {
        cancelled = true;
        timer.clearTimeout(handle);
    };
}
