// index.ts — dev 的**运行目录唯一真源**。
//
// 为什么单独成包（##518）：实例注册表的位置原先在 4 处各写一遍（workbench / diy-app / apps/web /
// remote 的 local 发现器），dev 启动器再写一遍读侧 —— 改一次目录要改五个地方，且必然漏。
// 现在只在这里定义：**别人一律 `import { registryDir } from "@diy-agent/dev-paths"`**。
//
// 位置（用户裁）：`~/.diy/dev/apps/<pid>.json`
//   · 挂在 `.diy` 下 = 与生产数据同根但独立分区，一眼能看出「这是 dev 工具的运行目录」；
//   · 不写进任何 DIY_HOME（lab 的 build/lab/home）：注册表描述的是**本机有哪些实例**，
//     跨数据根，属于设备级，不属于某个实例的数据根。
//
// 旧位置 `~/.diy-instances` 保留一次性搬移：**只在读侧触发**（写侧只写新目录），
// 搬完就没人再读旧的；搬不动（权限）只告警，不影响继续跑。

import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/** 真实家目录（不读 $HOME：测试 / 隔离实例会改写它） */
export function realHomeDir(): string {
    try {
        return userInfo().homedir || homedir();
    } catch {
        return homedir();
    }
}

/** dev 根目录（`DIY_DEV_HOME` 可覆盖；缺省 `~/.diy/dev`） */
export function devRoot(env: NodeJS.ProcessEnv = process.env): string {
    const override = env["DIY_DEV_HOME"];
    if (override !== undefined && override.trim() !== "") return override.trim();
    return join(realHomeDir(), ".diy", "dev");
}

/** 实例注册表目录（`DIY_INSTANCE_REGISTRY` 可覆盖，测试隔离用）；缺省 `<devRoot>/apps` */
export function registryDir(env: NodeJS.ProcessEnv = process.env): string {
    const override = env["DIY_INSTANCE_REGISTRY"];
    if (override !== undefined && override.trim() !== "") return override.trim();
    return join(devRoot(env), "apps");
}

/** 旧位置（一次性搬迁的来源）：`~/.diy-instances` */
export function legacyRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
    return join(realHomeDir(), ".diy-instances");
}

/** 确保注册表目录存在（写侧调用） */
export function ensureRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
    const dir = registryDir(env);
    mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * 把旧目录里的记录搬到新目录（一次性、幂等）。
 *
 * `.json` 文件按 pid 命名，新目录已有同名文件时**不覆盖**（新目录一定更新）。
 * 搬完旧目录即删（空目录也删）——避免下次再扫一遍。
 */
export function migrateLegacyRegistry(env: NodeJS.ProcessEnv = process.env): { moved: number; skipped: number; from: string; to: string } {
    const from = legacyRegistryDir(env);
    const to = registryDir(env);
    const result = { moved: 0, skipped: 0, from, to };
    if (from === to || !existsSync(from)) return result;
    let names: string[];
    try {
        names = readdirSync(from);
    } catch {
        return result;
    }
    try {
        mkdirSync(to, { recursive: true });
    } catch {
        return result;
    }
    for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const target = join(to, name);
        if (existsSync(target)) {
            result.skipped++;
            continue;
        }
        try {
            renameSync(join(from, name), target);
            result.moved++;
        } catch {
            result.skipped++;
        }
    }
    // 旧目录清空即删（非空 = 还有搬不动的，留着）
    try {
        if (readdirSync(from).length === 0) {
            renameSync(from, `${from}.migrated`);
        }
    } catch {
        /* 删不掉就算了 */
    }
    return result;
}
