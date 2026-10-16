// vite.pkg-deps.ts — vite 构建配置的**共享真源**（main / serve / preload 共用）
//
// 为什么单列一份（##319 review1 P2-A）：三份配置原先各写一份 `pkgDeps` ⇒ 加了 workspace 依赖
// `@diy/flow` / `@diy/talk` 只补了 main，`serve` 产物就留下裸 `import "@diy/flow"`
// （node 加载 workspace 的 `.ts` 源码直接炸：`ERR_MODULE_NOT_FOUND … /pkgs.ts/diy-flow/src/errors`）
// —— 而改动前 serve 产物**零**裸 `@diy/*` import，即「只新增、不改既有行为」被破坏。
// 包清单只有一份之后，换包漏加的可能只剩「忘了加进这个数组」一种。
import { builtinModules } from "node:module";
import { isAbsolute } from "node:path";

/**
 * 要**打包进来**的 workspace 包（它们只有 TS 源码；external 化 = 产物里留 `import "@diy/x"`，
 * node 加载 `.ts` 直接炸）。**新增 workspace 依赖必须同步加这里**。
 */
export const WORKSPACE_TS_DEPS = ["@diy/rpc", "@diy/template", "@diy/flow", "@diy/talk"];

/** 变体产物根：prod|test|preview|lab（见根 AGENTS.md「实例四态」） */
export const VARIANT = process.env.DIY_VARIANT ?? "prod";

// Windows 上解析结果是 `C:/…`：既不以 `./` 也不以 `/` 开头 —— 按「裸 id」判会误判成外部依赖，
// 于是产物里留下 `import … from "C:/…"`，ESM 加载抛 ERR_UNSUPPORTED_ESM_URL_SCHEME。
// 判据：绝对路径 = 已解析的本地源码，必须打包进来。
const isAbsPath = (id: string) => isAbsolute(id) || /^[a-zA-Z]:[\\/]/.test(id);

/** 运行时外置（node 内建 + electron）：这些不进 bundle */
const RUNTIME_EXTERNALS = ["electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

/**
 * 统一的 `rollupOptions.external` 判据：workspace 包 → **打包**；node 内建 / electron → 外置；
 * 其余裸 id（真第三方依赖）→ 外置；`./` `../` 与绝对路径 → 打包。
 */
export function isExternal(id: string, pkgDeps: readonly string[] = WORKSPACE_TS_DEPS): boolean {
  return pkgDeps.some((p) => id === p || id.startsWith(`${p}/`))
    ? false
    : RUNTIME_EXTERNALS.some((e) => id === e || id.startsWith(`${e}/`))
      ? true
      : isAbsPath(id)
        ? false
        : !/^[./]/.test(id);
}
