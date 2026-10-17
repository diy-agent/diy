// src/cli/probe-instance.ts
// 🎯 端口探活 + **实例身份校验**（CLI 侧复用判据）
//
// 为什么需要身份校验（##328(实例身份只靠端口)）：`app.port` 只记得「上次监听的端口」，不记得「那次是谁在监听」。
// 端口释放后可能被**另一个实例**（另一个 DIY_HOME 的 worktree dev / 测试实例）占用，
// 而旧行为只探「该端口上有 HTTP 响应」→ 于是把别人的实例当自己的用。
// 实测现场：生产 `~/.diy` 与 dev `build/<variant>/home` 都兜底 18888，
// 生产实例没在跑时，一条全局 `diy` 命令就连到了 dev 实例（数据根不同却串台）。
//
// 判据必须是**活体自报**：连上去问 `diy.getAppInfo`，比它回报的 `diyHome`。
// `app.port` / pid / startedAt 都只是缓存 —— 端口可能已被别人接管，文件可能陈旧，
// 「谁在监听」这个问题只有监听者自己答得准。

import { HttpClientBinding } from "@diy-agent/rpc/http";
import { sameDataHome } from "../main/core/instance-identity";

/** getAppInfo 里本判据要用到的字段（只取所需，避免依赖整份 schema） */
interface AppInfoLite {
  diyHome: string;
  pid: number;
  env: string;
}

/** 探活结果：mine = 本数据根的实例；other = 别人家的实例占着这个端口；none = 端口上没人应答 */
export type InstanceProbe =
  | { kind: "mine"; port: number; diyHome: string; pid: number; env: string }
  | { kind: "other"; port: number; diyHome: string; pid: number; env: string }
  | { kind: "none"; port: number };

/**
 * 探测某端口上的实例身份。
 * @param port 候选端口（一般来自 `app.port`）
 * @param home 本 CLI 的数据根（判定「是不是我的实例」的唯一依据）
 * @param timeoutMs 探活上限（连上并取回身份的总预算）
 */
export async function probeInstance(
  port: number,
  home: string,
  timeoutMs = 1500,
): Promise<InstanceProbe> {
  const client = new HttpClientBinding(`http://127.0.0.1:${port}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`probe timeout ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([client.ready(), deadline]);
    // 线协议要求 envelope 形态 `{ input, meta }`（`server-binding-core.ts::unwrap` 从这里解 input
    // 再做 zod 校验）—— 不是裸 input。传裸 `{}` 会被解成 `input: undefined` → INVALID_ARGUMENT
    // → 被下面的 catch 吞成 "none" → 认不出「端口上是别人」（正是本任务要修的那类静默误判）。
    // getAppInfo 无入参（api-def `input: {}`），故 input 给 `{}`。
    const info = await Promise.race([
      client.invoke<{ input: Record<string, never>; meta: Record<string, never> }, AppInfoLite>(
        "diy.getAppInfo",
        { input: {}, meta: {} },
      ),
      deadline,
    ]);
    const common = { port, diyHome: info.diyHome, pid: info.pid, env: info.env };
    return sameDataHome(info.diyHome, home)
      ? { kind: "mine", ...common }
      : { kind: "other", ...common };
  } catch {
    // 连不上 / 超时 / 回包不合契约（如对端根本没有这个方法）→ 当作「这里没有可复用的实例」
    return { kind: "none", port };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    client.dispose();
  }
}
