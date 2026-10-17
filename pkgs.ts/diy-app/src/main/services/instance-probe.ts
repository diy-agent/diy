// src/main/services/instance-probe.ts
// 🎯 对**别的 diy 实例**的活体探测（HTTP/2 RPC 客户端）。
//
// 与 `src/cli/probe-instance.ts` 的分工：
//   · 这里 = 协议实现（怎么连、怎么调、超时怎么算）—— **全仓唯一一份**；
//   · `cli/probe-instance.ts` = CLI 复用前的身份判据（`sameDataHome`），它 import 本文件的
//     `fetchAppInfo`，不再自己写一遍连接与 envelope 形态（##328 成果被两处复用，而不是抄两份）。
//
// 为什么探测必须「有超时 + 容错」：扫描期间实例可能正在退出/卡死；一行探测失败不该让整张表失败，
// 缺信息就如实标 `unreachable` —— 与「没这个实例」是两回事。
//
// ⚠️ envelope 形态（实测坑，见 probe-instance.ts 原注）：线协议要求 `{ input, meta }`，
// 传裸 `{}` 会被解成 `input: undefined` → INVALID_ARGUMENT → 被 catch 吞成「无响应」，
// 于是「端口上是别人/版本太老」这类真信息全丢。

import { HttpClientBinding } from "@diy-agent/rpc/http";
import type { InstanceSelf, RevealResult } from "../../shared/instance-row";

// 类型从共享契约来（**单源**：schema 在 shared/instance-row.ts，UI 与 main 同一份）；
// 这里 re-export，调用方（services/instances.ts 等）不必知道契约文件在哪。
export type { InstanceSelf, RevealResult };

/** `diy.getAppInfo` 里本模块要用的字段（只取所需，避免依赖整份 schema） */
export interface AppInfoLite {
  diyHome: string;
  pid: number;
  env: string;
  port?: number;
  branch?: string;
  repoDisplay?: string;
}

/** 一次调用的总预算包装：连上 + 调用共用同一个 deadline（`probe-instance` 的写法保留） */
async function withBudget<T>(timeoutMs: number, fn: (client: HttpClientBinding) => Promise<T>, port: number): Promise<T> {
  const client = new HttpClientBinding(`http://127.0.0.1:${port}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`probe timeout ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([client.ready(), deadline]);
    return await Promise.race([fn(client), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    client.dispose();
  }
}

/**
 * 读某端口上的实例身份（`diy.getAppInfo`）。**失败即抛**（超时 / 连不上 / 契约不符）——
 * 调用方决定「吞成无响应」还是「当作别人的实例」，判据不在这一层。
 */
export async function fetchAppInfo(port: number, timeoutMs = 1500): Promise<AppInfoLite> {
  return withBudget(
    timeoutMs,
    (client) =>
      client.invoke<{ input: Record<string, never>; meta: Record<string, never> }, AppInfoLite>("diy.getAppInfo", {
        input: {},
        meta: {},
      }),
    port,
  );
}

/**
 * 读某端口上实例的**自报全量**（`diy.instances.self`）。
 * 失败 → null（这一条路径要容错：本功能上线前启动的老实例根本没有这个方法，
 * 那时降级到 `fetchAppInfo` 拿身份 —— 见 `probeInstanceRow`）。
 */
export async function fetchInstanceSelf(port: number, timeoutMs = 1500): Promise<InstanceSelf | null> {
  try {
    return await withBudget(
      timeoutMs,
      (client) =>
        client.invoke<{ input: Record<string, never>; meta: Record<string, never> }, InstanceSelf>("diy.instances.self", {
          input: {},
          meta: {},
        }),
      port,
    );
  } catch {
    return null;
  }
}

/** 让目标实例把窗口请出来（`diy.instances.reveal`，由目标实例自己 show+focus+全屏） */
export async function revealInstance(port: number, timeoutMs = 2500): Promise<RevealResult> {
  return withBudget(
    timeoutMs,
    (client) =>
      client.invoke<{ input: Record<string, never>; meta: Record<string, never> }, RevealResult>("diy.instances.reveal", {
        input: {},
        meta: {},
      }),
    port,
  );
}
