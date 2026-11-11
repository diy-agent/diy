/**
 * domain-apis.ts — 各域 api 的汇总（**新模型**：模块自带模块层）
 *
 * 每个 `<x>Api` 的形状是 `group({ children: { <x>: <x>Routes } })`：
 * 模块层由模块自己声明，**app 前缀由宿主（CLI / server）给**。
 *
 * 为什么单独一个文件：CLI 与 `/cli` 端点都要按同一份清单建 scoped client，
 * 两边各写一份清单迟早漏（历史上 `--json` 就只在一处识别过）。
 *
 * 服务端仍走 `defineService`（存量太大，两者等价：`name: "diy.x"` = prefix `diy` + 模块层 `x`）。
 */
import { agentApi } from "./api-domains/agent/api";
import { appApi } from "./api-domains/app/api";
import { cacheHintApi } from "./api-domains/cacheHint/api";
import { contextApi } from "./api-domains/context/api";
import { docsApi } from "./api-domains/docs/api";
import { envApi } from "./api-domains/env/api";
import { factsApi } from "./api-domains/facts/api";
import { flowApi } from "./api-domains/flow/api";
import { hubApi } from "./api-domains/hub/api";
import { instancesApi } from "./api-domains/instances/api";
import { jobApi } from "./api-domains/job/api";
import { journalApi } from "./api-domains/journal/api";
import { kbApi } from "./api-domains/kb/api";
import { llmConfigApi } from "./api-domains/llmConfig/api";
import { llmProxyApi } from "./api-domains/llmProxy/api";
import { logApi } from "./api-domains/log/api";
import { noticeApi } from "./api-domains/notice/api";
import { projectApi } from "./api-domains/project/api";
import { remoteApi } from "./api-domains/remote/api";
import { roomApi } from "./api-domains/room/api";
import { seedApi } from "./api-domains/seed/api";
import { RpcSchema } from "@diy-agent/rpc";
import { apiDef } from "./api-def";
import { taskApi } from "./api-domains/task/api";
import { templateApi } from "./api-domains/template/api";
import { toolApi } from "./api-domains/tool/api";
import { trafficApi } from "./api-domains/traffic/api";
import { uiApi } from "./api-domains/ui/api";
import { watchApi } from "./api-domains/watch/api";

/**
 * 顶层 unary（不属于任何域）：`diy.doctor`。
 *
 * 它没有域可直接归属，所以从 apiDef 上取 meta 包成同形的模块层
 * （`domain-apis → api-def → api-domains/*`，不会回到本文件，无循环）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doctorRoutes = (apiDef.diy as any).doctor;

/** 与其它域同形：`group({ children: { <域>: <routes> } })` */
export const doctorApi = RpcSchema.group({ children: { doctor: doctorRoutes } });

export const domainApis = [
    doctorApi,
    agentApi,
    appApi,
    cacheHintApi,
    contextApi,
    docsApi,
    envApi,
    factsApi,
    flowApi,
    hubApi,
    instancesApi,
    jobApi,
    journalApi,
    kbApi,
    llmConfigApi,
    llmProxyApi,
    logApi,
    noticeApi,
    projectApi,
    remoteApi,
    roomApi,
    seedApi,
    taskApi,
    templateApi,
    toolApi,
    trafficApi,
    uiApi,
    watchApi,
] as const;
