// src/main/core/rm.ts
// 🎯 递归删数据目录的**唯一实现**（Windows 上必须两段式 + 逐项删以报出卡住的那个）。
//
// 为什么需要：
//   · `fs.rmSync(dir, {recursive:true})` 在 Windows 上会间歇抛 **ENOTEMPTY / EBUSY** ——
//     删的时候里面还有句柄没释放（杀毒扫描 / 搜索索引 / 上一毫秒刚写的文件）；
//   · 更常见的是 **EPERM** —— 目录或其中某个条目带**只读属性**（Windows 删只读文件就是 EPERM），
//     或某个进程把它当 cwd。
// POSIX 上「删正在被打开的目录」通常也成功，所以这些病**只在 Windows 露头**，且上游命令直接失败：
//   实测 `diy.sh project remove <id>`
//     → `Error: ENOTEMPTY, Directory not empty: …\projects\3`        （原始实现）
//     → `Error: EPERM, Permission denied: …\projects\3`             （只加 maxRetries 之后）
//   project / task 删不掉 ⇒ intent 里所有「建了再删」的用例连锁失败。
//
// 策略（依次）：
//   ① `rmSync` 带 `maxRetries/retryDelay`（Node 仅在 recursive 时重试 EBUSY/ENOTEMPTY/EPERM）；
//   ② 还失败 ⇒ **深度优先逐项删**（文件 `rmSync`、目录 `rmdirSync`），每项各带重试。
//      逐项删的意义：抛出来的错误路径就是**真正卡住的那一项**——`rmSync(recursive)` 只会报顶层
//      目录，看不出是谁锁着，只能靠猜（本案就因此白跑了一轮）。
//
// ⚠️ 全异步（2026-11-01 用户裁）：Node 单线程，同步 IO 会卡死主进程 —— 这是原则，
//   不是风格偏好。`fs/promises` 的 `rm` 同样支持 maxRetries / retryDelay，语义等价。
//   ⇒ 所有调用点必须 `await`；`removeDirRobust` 返回 Promise，别再当同步用。
//
// 不吞错：删不掉就抛（带具体路径）——「删不掉」是必须让人知道的事实（曾静默忽略一次，
// 结果是测试临时目录攒到 2.9GB 没人发现）。
import { readdir, rmdir, rm } from "node:fs/promises";
import { join } from "node:path";

const RETRY = { maxRetries: 10, retryDelay: 50 } as const;

/** 深度优先逐项删；失败时错误里带的是**最深处那个条目**的路径 */
async function rmDeep(dir: string): Promise<void> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
        // 目录已经不存在 ⇒ 目标达成；其它错误（权限）如实抛
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        throw e;
    }
    for (const entry of entries) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
            await rmDeep(p);
        } else {
            await rm(p, { force: true, ...RETRY });
        }
    }
    await rmdir(dir);
}

/**
 * 删目录（数据目录 / 任务目录 / 锁目录…）：POSIX 上等价 `rm -rf`，Windows 上自带两段兜底。
 */
export async function removeDirRobust(dir: string): Promise<void> {
    try {
        await rm(dir, { recursive: true, force: true, ...RETRY });
        return;
    } catch {
        // 逐项删：既兜住 recursive 删不掉的场景，也让失败信息指出**具体**是谁卡住
        await rmDeep(dir);
    }
}
