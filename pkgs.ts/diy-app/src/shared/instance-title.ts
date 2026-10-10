// src/shared/instance-title.ts
// 🎯 窗口标题 = 「这是哪个实例」的唯一标识（纯函数，main 与 renderer 共用一份实现）。
//
// 为什么需要：diy 允许多实例并行，各自的数据根（DIY_HOME）完全不同 ——
//   生产     ~/.diy
//   worktree <repo>/build/<variant>/home（`./diy.sh` / preview / lab 的隔离数据根）
//   测试     mkdtemp 临时目录
// 此前标题只有 "diy solid"，切窗口 / macOS 标题栏 / dock 悬停全都认不出谁是谁，
// 排查「我这条命令打到哪个实例的数据」时只能靠猜。
//
// 为什么还要仓库路径 / 端口 / PID（任务 177）：只有数据根仍然不够用 ——
//   · 数据根本身看不出「是哪份代码在跑」（`./build/*/home`、`/tmp/diy-app-test-xxx` 尤其），
//     故把**仓库/worktree 路径**放最前（早先显示 git 分支；同分支不同代码时反而误导）
//   · 同分支多实例、dev 热重启后端口会变（18888 ↔ 随机），端口是「命令打给谁」的直接抓手
//   · PID 用来确认「眼前这个窗口 = 那个进程」，排查残留实例 / 单实例锁问题时必需
//
// 为什么数据根要先缩写（abbrevHome）：`/Users/<name>` 前缀无信息量。
// ⚠️ 缩写基准必须是**真实家目录**（main 侧用 getpwuid 取，见 core/instance-identity.ts），
// 不能直接用 $HOME —— 测试/隔离实例会把 HOME 指到临时目录，那时 DIY_HOME === $HOME，
// 缩写产物是 `~`，标题里的数据根退化成 `~`：看着像用户家目录，其实是个 /tmp 临时根。
//
// 例：`~/git/diy/diy🔹~/git/diy/diy/build/preview/home🔹port:18888🔹pid:4242`
//     `~/git/diy/diy🔹/var/folders/…/diy-app-test-abc123🔹port:52341🔹pid:53087`

/**
 * 把数据根缩成 `~` 开头（省掉 /Users/<name> 这类无信息量的前缀）。
 *
 * ⚠️ `homeDir` 必须是**真实家目录**。若传被隔离的 $HOME（测试把 HOME 指向 mkdtemp 时），
 * DIY_HOME 与它相等 → 产出 `~`，把「临时数据根」伪装成「用户家目录」，正是任务 177 报的 bug。
 *
 * 只处理两种精确情形，不做「找最近的公共前缀」那种猜测：
 *   home === homeDir        → `~`
 *   home 在 homeDir 之下     → `~/...`
 * 其余（如测试的 /tmp/diy-app-test-xxx）原样返回 —— 它们本来就不在用户家目录下。
 */
export function abbrevHome(home: string, homeDir: string): string {
  if (!home) return "";
  const base = homeDir.replace(/\/+$/, "");
  if (!base) return home;
  if (home === base) return "~";
  if (home.startsWith(`${base}/`)) return `~${home.slice(base.length)}`;
  return home;
}

/** 组装标题所需的事实。缺的字段直接不出现（`pid 0` / `:0` 这类占位比留白更难看） */
export interface InstanceIdentity {
  /** 当前代码仓库（或 worktree）的展示路径 */
  repoDisplay: string;
  /** 数据根（DIY_HOME）的展示形式：绝对路径，或相对**真实家目录**的 `~/…` */
  homeDisplay: string;
  /** 运行环境（兼容保留，不再显示） */
  env: string;
  /** 当前运行代码所在 git 分支（拿不到时省略） */
  branch?: string | null;
  /** RPC 端口（尚未绑定 / 未知时省略） */
  port?: number | null;
  /** 进程 PID */
  pid?: number | null;
}

/**
 * 组装窗口标题：`<仓库>🔹<数据根>🔹port:<端口>🔹pid:<PID>`。
 *
 * 仓库路径用于识别哪份代码，数据根用于识别哪份运行数据；端口与 PID 用于定位实际实例。
 * 字段缺失时显示 `?`，保持标题结构稳定。
 */
export function instanceTitle(id: InstanceIdentity): string {
  return [
    id.repoDisplay || "?",
    id.homeDisplay || "?",
    `port:${id.port ?? "?"}`,
    `pid:${id.pid ?? "?"}`,
  ].join("🔹");
}
