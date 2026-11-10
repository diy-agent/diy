// scripts/publish-targets.mjs — 「哪些包/应用要发 npm」的**唯一清单**（##522）
//
// 为什么单独成文件：清单原先硬编码在根 sha.sh 的 `_npm_publish_pkgs` 里，而发版工具
// （scripts/release.mjs）也要用它挑 bump 对象 —— 两份必然漂移（加了新包只改一处，
// release 就漏 bump 它，publish 时撞「版本已存在」）。现在两边都从这里取。
//
// 判据：不是「所有 workspace 包」，而是**做过 npm 分发准备**的那些（有 build-artifact /
// dist 发行形态），其余包只 `private: true` 留在仓内。
export const PUBLISH_TARGETS = [
    'pkgs.ts/core/rpc',
    'pkgs.ts/ui/core',
    'pkgs.ts/agent/session',
    'pkgs.ts/agent/store-jsonl',
    'pkgs.ts/ui/workbench',
    'pkgs.ts/ui/workbench-ui',
    'pkgs.ts/model/catalog',
    'pkgs.ts/ui/model-config',
    'pkgs.ts/model/provider',
    'pkgs.ts/agent/bot',
    'pkgs.ts/ui/chat-page',
    'pkgs.ts/ui/workbench-plugin',
    'pkgs.ts/core/dev-paths',
    'apps/chat',
];

// `node scripts/publish-targets.mjs` ⇒ 一行一个（给 bash 的 mapfile 用）
if (process.argv[1] && process.argv[1].endsWith('publish-targets.mjs')) {
    for (const t of PUBLISH_TARGETS) console.log(t);
}
