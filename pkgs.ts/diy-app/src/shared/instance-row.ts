// src/shared/instance-row.ts
// 🎯 「实例行」契约 —— `diy instances ls` / `instances.list` / UI 实例页三方共用。
//
// 纯 zod、零 node 依赖（rule.pit.zod-cli-meta-order：共享契约模块必须零依赖，
// 否则打包时被拖进共享 chunk、schema 在 `_cli-meta` 补丁之前创建）。
//
// 一行 = **一个 diy 实例**（不是「一个进程」）：一个实例有 Electron 主 + GPU + renderer + helper
// 多个进程，只有主进程（`build/<variant>/main/index.mjs`）算一行 —— 去重规则见
// main/core/instance-scan.ts::pickInstanceProcesses。
import { z } from "zod";

/** 本实例正在跑的一轮（来自 session-registry，跨实例由 `instances.self` 自报） */
export const InstanceTurnSchema = z.object({
  uri: z.string().describe("任务 URI"),
  since: z.string().describe("本轮起始时刻（ISO）"),
  steps: z.number().describe("已跑步数"),
  model: z.string().optional().describe("本轮模型"),
});
export type InstanceTurn = z.infer<typeof InstanceTurnSchema>;

/** 窗口状态（只有自报成功的行才有 —— 无窗口的 serve 实例为 null） */
export const InstanceWindowSchema = z.object({
  visible: z.boolean(),
  fullScreen: z.boolean(),
  minimized: z.boolean(),
});

/**
 * 一行实例。
 *
 * ⚠️ 「真数据根」的判据是**实例自报**（`instances.self.diyHome` / `getAppInfo.diyHome`），
 * 不是环境变量：实测 `ps eww` 里的 `DIY_HOME` 是**继承**来的（preview 的 launcher 带着
 * 用户 shell 的 `DIY_HOME=~/.diy`，它 spawn 的 Electron 真数据根却是 `build/<v>/home`）。
 * 故 `diyHome` + `homeSource` 成对出现：自报到了才叫真根，没自报到的只算线索（`hint`）。
 */
export const InstanceRowSchema = z.object({
  pid: z.number().describe("实例主进程 pid"),
  kind: z.string().describe("electron | serve"),
  variant: z.string().describe("产物变体（从入口路径推：prod|test|preview|lab）"),
  diyHome: z.string().describe("数据根（自报优先；拿不到时是线索值或空串）"),
  diyHomeDisplay: z.string().describe("数据根的展示形式（相对真实家目录缩 ~）"),
  homeSource: z.string().describe("数据根来源：self（实例自报）| hint（继承环境变量）| unknown"),
  env: z.string().describe("运行环境（production|development|test）"),
  branch: z.string().describe("当前代码所在 git 分支（拿不到为空串）"),
  repoDisplay: z.string().describe("代码仓库/worktree 展示路径"),
  port: z.number().nullable().describe("RPC 端口（未就绪/未注册为 null）"),
  source: z.string().describe("「谁开的」摘要（启动时自报的父进程链；拿不到写「来源未知」）"),
  sourceKind: z.string().describe("registry（注册表自报）| unknown（老实例，事后追不出）"),
  cmdline: z.string().describe("启动命令行摘要（截断）"),
  cwd: z.string().describe("实例进程 cwd（注册表自报）"),
  startedAt: z.string().nullable().describe("启动时刻（ISO；注册表自报，老实例为 null）"),
  status: z.string().describe("ready（探测通）| no-port（无端口）| unreachable（有端口无响应）| unregistered"),
  note: z.string().describe("补充说明（问题/线索，正常为空串）"),
  sessions: z.number().describe("本次启动后活跃过的会话数（自报）"),
  running: z.number().describe("此刻在跑的轮次数（自报）"),
  activeTurns: z.array(InstanceTurnSchema).describe("在跑的轮次明细（自报）"),
  window: InstanceWindowSchema.nullable().describe("窗口状态（无窗口/未自报为 null）"),
});
export type InstanceRow = z.infer<typeof InstanceRowSchema>;

/**
 * 本实例自报（RPC `instances.self`）—— 别的实例扫到它时**唯一可信的身份来源**。
 *
 * 为什么自报而不是「外面怎么看它」：数据根 / 环境 / 分支 / 端口都是**进程内的事实**
 * （`AppConfig.diyHome` 经 dev-home 纠正、端口是实际 listen 的那个），外面只能猜。
 */
export const InstanceSelfSchema = z.object({
  pid: z.number(),
  port: z.number().describe("实际 RPC 端口（0 = 还没就绪）"),
  diyHome: z.string(),
  diyHomeDisplay: z.string(),
  env: z.string(),
  variant: z.string(),
  branch: z.string(),
  repoDisplay: z.string(),
  startedAt: z.string(),
  sessions: z.number().describe("本次启动后活跃过的会话数"),
  running: z.number().describe("此刻在跑的轮次数"),
  activeTurns: z.array(InstanceTurnSchema),
  /** 窗口状态；无窗口（serve / 窗口已关）为 null */
  window: InstanceWindowSchema.nullable(),
});
export type InstanceSelf = z.infer<typeof InstanceSelfSchema>;

/** `instances.reveal` 的回执：唤起本实例窗口的结果（失败必须带原因，绝不静默成功） */
export const RevealResultSchema = z.object({
  ok: z.boolean(),
  reason: z.string().describe("人话说明（成功也说一句；失败必说为什么）"),
  fullScreen: z.boolean().describe("唤起后是否处于全屏"),
});
export type RevealResult = z.infer<typeof RevealResultSchema>;
