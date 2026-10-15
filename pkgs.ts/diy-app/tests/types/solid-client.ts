// tests/types/solid-client.ts
// ═══════════════════════════════════════════════════════════════
// 类型垫片：让类型检查认得 solid-js 的**客户端**构建（`solid-js/dist/solid.js`）。
//
// 为什么需要：node 条件下 `solid-js` 解析到 **SSR 构建**，而 SSR 构建的 `createEffect`
// 是空实现（不追踪依赖）—— 响应式契约的回归测试必须跑客户端实现，否则会静默空跑（假绿）。
// 该包的 exports 里 "./dist/*" 只映射路径、没有 types 映射 ⇒ 不垫这层，`import("solid-js/dist/solid.js")`
// 就报 TS7016（隐式 any）。见 tests/core/session-store.test.ts 头注。
//
// 为什么是 `.ts` 而不是 `.d.ts`：产物护栏（scripts/check-no-emit.sh）**一律**禁掉
// `pkgs.ts/*/{src,tests,test,scripts}` 下的 `.d.ts`（它无法区分"手写垫片"与"误 emit 产物"）。
// 本文件无 import/export ⇒ 是脚本文件，其中的 `declare module` 就是**环境模块声明**，
// 效果与 `.d.ts` 等价，且不会成为任何东西的解析目标（没人 import 它）。
// ═══════════════════════════════════════════════════════════════
declare module "solid-js/dist/solid.js" {
    export * from "solid-js";
}
