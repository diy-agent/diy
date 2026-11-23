// src/main/core/dev-home.ts
// 🎯 数据根决策：**只认显式值**（`DIY_HOME` / `--home`），非生产缺了直接报错。
//
// 为什么不再「按变体推导」（2026-11-23 裁）：`build/<variant>/home` 那套把「产物根」与
// 「数据根」绑在同一个标签上，于是同一个 `build/` 既装可再生成的产物、又装不可再生成的数据，
// `clean = rm -rf build` 一条命令就能把库删掉（`apps/diy2/build/prod/home/diy2.db` 实际发生过）。
// 现在：产物固定 `build/prod`，数据根由入口脚本算好显式传（`run/<app>/<label>`），
// 核心代码不认识任何「label → 路径」的映射。
//
// 两条硬约束不变：
//   1. 不许把非生产实例指向**生产数据根**（`~/.diy`）—— 那会写脏真库；
//   2. 自定义临时目录（实验用）照旧透传。
//
// 「生产根是什么」**只有一个定义处**：`core/instance-identity.ts::prodDataHome`（用**真实**
// 家目录，不读会被改写的 `$HOME`）。
import { isProdDataHome } from "./instance-identity";

export type DataHomeDecision = {
    /** 真正生效的数据根（一律等于显式传入值） */
    home: string;
};

/**
 * 决定非生产实例的数据根。
 *
 * @param opts.explicit 显式数据根（`DIY_HOME` / `--home`）；**空 = 报错**，不推导、不回落
 * @param opts.allowProdHome `DIY_ALLOW_PROD_HOME=1` 时放行生产根（明确知情的选择）
 * @param opts.hint 报错时追加的现成命令（入口脚本传，如 `./diy.sh lab`），让人知道怎么补
 */
export function resolveDataHome(opts: {
    explicit?: string | undefined;
    allowProdHome?: boolean | undefined;
    hint?: string | undefined;
}): DataHomeDecision {
    const explicit = opts.explicit?.trim();
    if (!explicit) {
        throw new Error(
            "非生产实例必须显式给数据根：DIY_HOME=<dir>（或 --home <dir>）" +
                (opts.hint ? `，例如 \`${opts.hint}\`` : "") +
                " —— 生产入口缺省 ~/.diy，非生产不再按变体推导路径",
            { cause: { code: "config/home-required" } },
        );
    }
    if (isProdDataHome(explicit) && opts.allowProdHome !== true) {
        throw new Error(`拒绝用生产数据根跑非生产实例：${explicit}` + "（确要如此：DIY_ALLOW_PROD_HOME=1 显式声明）", {
            cause: { code: "config/prod-home-refused" },
        });
    }
    return { home: explicit };
}
