// src/main/core/dev-home.ts
// 🎯 dev 变体（preview / lab）的**数据根决策**：`<repoRoot>/build/<variant>/home`，
// 并拒绝继承来的**生产根**。
//
// 为什么单独成文件：这条规则有两个消费者（`scripts/electron-dev.mts` 起实例、`core/seed.ts`
// 种数据），而它守的是「别把演示数据写进用户真实数据根」—— 必须被测到，可脚本进程跑不进单测。
//
// 实测的坑：宿主 shell / agent / CI 常导出 `DIY_HOME=~/.diy`。preview 若照单全收，就开着
// 生产数据根跑（只因 prod 实例占着单实例锁才没出事）；更糟的是 preview **缺省带初始种入**，
// 真跑起来会把示例项目与任务写进生产。
//
// 「生产根是什么」**只有一个定义处**：`core/instance-identity.ts::prodDataHome`（用**真实**
// 家目录，不读会被改写的 `$HOME`）。本文件只管「撞上了怎么办」—— 回落本变体的 home。
import { join } from "node:path";
import { isProdDataHome } from "./instance-identity";

export type DevHomeDecision = {
    /** 真正生效的数据根 */
    home: string;
    /** 被拒绝的继承值（null = 没有拒绝任何东西）；调用方据此打警告 */
    rejected: string | null;
};

/**
 * 决定 dev 变体的数据根。
 * 继承来的 `DIY_HOME` 指向生产根 → 拒绝，改用 `build/<variant>/home`（除非 `allowProdHome`）；
 * 其余自定义值照旧透传 —— 实验常用临时 home，那条路不能被掐。
 */
export function resolveDevHome(opts: {
    variant: string;
    repoRoot: string;
    inherited?: string | undefined;
    allowProdHome?: boolean;
}): DevHomeDecision {
    const fallback = join(opts.repoRoot, "build", opts.variant, "home");
    const inherited = opts.inherited?.trim();
    if (!inherited) return { home: fallback, rejected: null };
    if (isProdDataHome(inherited) && !opts.allowProdHome) {
        return { home: fallback, rejected: inherited };
    }
    return { home: inherited, rejected: null };
}
