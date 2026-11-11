/**
 * api-domains/seed/api.ts — `seed` 域的 RPC 契约（**模块级服务**）
 *
 * 2026-11-06 从 `services/api-def.ts`（3659 行的单一树）拆出来。
 * **为什么要拆**：`api-def.ts` 是「一棵大 diy API 树」，加一个 API 就得改那一个文件；
 * 拆成每域一个 `defineService` 之后，各域可以独立演进、独立测试，也**为将来挪进
 * 各自的 pkg 做好准备**（`@diy-agent/task` / `@diy-agent/facts` / ...）。
 *
 * 目录约定（照着 `examples/service/*` 和 `pkgs.ts/ui/workbench/src/api.ts`）：
 *   <域>/api.ts    ← 手写，唯一真源（生成器的扫描约定）
 *   <域>/gen/      ← 生成的 `.d.ts`（别手改）
 *   <域>/impl.ts   ← handler 绑定
 *
 * ⚠️ 注：`diy-app/src` 不在 `gen-service-types` 的扫描根（只扫 `pkgs.ts/` 与 `apps/*\/src`），
 * 但这里路径正是 `apps/diy-app/src/...`，会被扫到。
 */
import { z } from "zod";
import { RpcSchema } from "@diy-agent/rpc";
import { FALLBACK_MODEL } from "../../../../shared/model-default";
import { SeedReportSchema } from "../../../../shared/model-config";

export const seedRoutes = RpcSchema.group({
    desc: `初始数据种入（lab 空数据根；幂等，已存在不动）—— 只种**示例/测试数据**，真配置由 ./sha.sh sync 同步`,
    children: {
        run: RpcSchema.unary({
            desc: `种入最小可用数据：opencode-go 模型配置（$VAR 占位）+ 缺省人物（缺省模型：free 优先 → 退 ${FALLBACK_MODEL}）+ 示例项目与任务`,
            input: {},
            output: SeedReportSchema,
        }),
    },
});


/**
 * 新模型（##87）：模块自带模块层，app 前缀由宿主给。
 * `server.use({ prefix: "diy", api: seedApi, handlers: { seed: … } })`
 * 与上面的 `seedService` 完全等价（后者 = prefix "diy" + 模块层 "seed"）。
 */
export const seedApi = RpcSchema.group({ children: { seed: seedRoutes } });
