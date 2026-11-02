// core/open-url.ts — 「在系统浏览器打开 URL」的判定与调用（##507 远程页 web 访问）。
//
// 为什么抽成纯函数 + 注入端口（而不是在 api-impl 里直接 import electron）：
//   1. 单测不能 `vi.mock("electron")`（##402：`test-unit` 跑 --no-isolate，vi.mock 会静默失效，
//      见 scripts/check-no-vi-mock.sh）—— 注入一个手写假 `openExternal` 才测得准；
//   2. 校验（只许 http/https）与调用分开，边界一眼可读。
export interface OpenExternalPort {
  openExternal(url: string): Promise<void>;
}

export interface OpenUrlResult {
  ok: boolean;
  /** 失败原因（人话）；成功为 null */
  message: string | null;
}

/**
 * 打开 URL：**只接受 http(s)**（`file://` / 自定义 scheme 一律拒，避免变成任意命令入口）。
 * 失败不抛 —— 回 `ok:false` + 原文，调用方摆到红条 / toast。
 */
export async function openUrlWith(port: OpenExternalPort, raw: string): Promise<OpenUrlResult> {
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, message: `只接受 http(s) URL：${url}` };
  }
  try {
    await port.openExternal(url);
    return { ok: true, message: null };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
