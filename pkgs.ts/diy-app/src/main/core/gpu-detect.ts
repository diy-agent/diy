// src/main/core/gpu-detect.ts
// 🎯 GPU 能力检测：macOS Metal GPUFamily 级别探测 + Chromium 启动参数建议
//
// 注意：GPU 检测是防御性措施。渲染进程崩溃的已知根因是 Chromium 150 的 rust_png bug
// （见 AGENTS.md），与 GPU/Metal 无关。--use-gl=angle 对 rust_png 崩溃无效。
//
// 保留此检测的原因：
//   1. Metal GPUFamily < 3 的旧 Mac 可能在未来遇到其他 GPU 渲染路径问题
//   2. 作为环境诊断信息记录到 main.log，便于排查

import { execFileSync } from "node:child_process";

interface GpuInfo {
  /** Metal GPUFamily 级别（macOS 1=基本, 2=Intel/旧AMD, 3+=Apple Silicon） */
  metalFamily: number;
  /** GPU 名称（首个） */
  gpuName: string;
  /** 是否建议使用 ANGLE/GL 后端替代 Metal（防御性） */
  shouldUseAngle: boolean;
}

let _cached: GpuInfo | null = null;

export function detectGpu(): GpuInfo {
  if (_cached) return _cached;
  const defaults: GpuInfo = { metalFamily: 99, gpuName: "unknown", shouldUseAngle: false };
  try {
    const out = execFileSync("system_profiler", ["SPDisplaysDataType"], {
      timeout: 3000, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    });
    const metalMatch = out.match(/Metal Family:.*?Metal GPUFamily macOS (\d+)/);
    const family = metalMatch ? parseInt(metalMatch[1], 10) : 99;
    const gpuMatch = out.match(/Chipset Model:\s*(.+)/);
    const gpuName = gpuMatch?.[1]?.trim() ?? "unknown";
    const shouldUseAngle = family < 3;
    _cached = { metalFamily: family, gpuName, shouldUseAngle };
    console.log(`[gpu] GPU: ${gpuName} (Metal GPUFamily macOS ${family})`);
    if (shouldUseAngle) {
      console.log(`[gpu] Metal GPUFamily < 3，添加 --use-gl=angle（防御性，非 rust_png 崩溃的修复）`);
    }
    return _cached;
  } catch {
    console.log("[gpu] GPU 检测失败（system_profiler 不可用），跳过");
    return defaults;
  }
}

export function gpuCompatArgs(): string[] {
  const gpu = detectGpu();
  return gpu.shouldUseAngle ? ["--use-gl=angle"] : [];
}
