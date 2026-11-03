// src/main/core/gpu-detect.ts
// 🎯 GPU 能力检测 —— 现在只是 `os.gpu()` 的薄封装。
//
// 探测实现（macOS 的 system_profiler / 其他平台的空实现）在 `main/os/`，见 os/types.ts 头注；
// 这里保留文件名是为了不惊动调用方（`main/index.ts` 只关心 `shouldUseAngle`）。

import { os } from "../os";
import type { GpuInfo } from "../os";

export type { GpuInfo };

export function detectGpu(): GpuInfo {
    return os.gpu();
}
