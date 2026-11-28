// models.dev 规格快照的读取入口。
//
// 快照**不进 git**：`scripts/gen.ts` 从 https://models.dev/api.json 拉下来写到 data/，
// npm 打包时（prepack）也会生成一次，所以发布出去的包里是有的。
// 这里只暴露路径、不 import JSON —— 6.5 MB 的规格在启动时解析一次要几十毫秒，
// 只在真要用它时才由 catalog 读。

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 快照文件位置（源码态与 dist 态都指向包根的 data/）。 */
export function bundledSnapshotPath(): string {
    return fileURLToPath(new URL('../data/models.dev.json', import.meta.url));
}

/** 快照在不在。没生成 / 没下载到时返回 false，catalog 会照旧报「缺快照」。 */
export function hasBundledSnapshot(): boolean {
    return existsSync(bundledSnapshotPath());
}
