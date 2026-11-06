/**
 * api-domains/seed/impl.ts — `seed` 域的 handler 绑定
 *
 * 与 `api.ts` 成对：契约归契约、实现归实现，但**同一个域的两半放在一起** ——
 * 将来整个目录搬到 `@diy-agent/seed` 时，不需要在别的文件里找 handler。
 *
 * 与老写法（`binding.on(app.seed.run, ...)`）的差别：
 *   · 老：meta 来自 `apiDef` 那棵大树，靠 `bindNames` 回写 name
 *   · 新：`seedService.bind` 自己拼 `${name}.${path}`，**不改原 meta**
 *   · 注册出来的 key 都是 `diy.seed.run`，等价
 */
import type { ServerBinding } from "@diy-agent/rpc";
import * as state from "../../../core/state";
import { seedHome } from "../../../core/seed";
import { refreshModelRuntime } from "../../../core/model-runtime";
import { seedService } from "./api";

/**
 * 把 `seed` 域挂到 binding 上。
 *
 * 为什么导出函数而不是在模块顶层 `seedService.bind(...)`：
 * binding 是宿主建的（`api-impl.ts` 里），模块加载时还不存在。
 */
export function bindSeed(server: ServerBinding): void {
    seedService.bind(server, {
        run: async () => {
            const r = seedHome(state.diyHome());
            // 种子可能新写了 model.yaml → 重装目录，让 UI 立刻看到模型
            refreshModelRuntime(state.diyHome());
            return r;
        },
    });
}
