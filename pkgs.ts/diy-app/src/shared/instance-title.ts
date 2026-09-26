// src/shared/instance-title.ts
// 🎯 窗口标题 = 「这是哪个实例」的唯一标识（纯函数，main 与 renderer 共用一份实现）。
//
// 为什么需要：diy 允许多实例并行，各自的数据根（DIY_HOME）完全不同 ——
//   生产     ~/.diy
//   worktree <repo>/build/home（`./diy.sh` 的隔离数据根）
//   测试     mkdtemp 临时目录
// 此前标题只有 "diy solid"，切窗口 / macOS 标题栏 / dock 悬停全都认不出谁是谁，
// 排查「我这条命令打到哪个实例的数据」时只能靠猜。
//
// 为什么还要分支 / 端口 / PID（任务 177）：只有数据根仍然不够用 ——
//   · 数据根本身看不出「是哪个分支的代码在跑」（`./build/home`、`/tmp/diy-app-test-xxx` 尤其）
//   · 同分支多实例、dev 热重启后端口会变（18888 ↔ 随机），端口是「命令打给谁」的直接抓手
//   · PID 用来确认「眼前这个窗口 = 那个进程」，排查残留实例 / 单实例锁问题时必需
//
// 为什么数据根要先缩写（abbrevHome）：`/Users/<name>` 前缀无信息量。
// ⚠️ 缩写基准必须是**真实家目录**（main 侧用 getpwuid 取，见 core/instance-identity.ts），
// 不能直接用 $HOME —— 测试/隔离实例会把 HOME 指到临时目录，那时 DIY_HOME === $HOME，
// 缩写产物是 `~`，标题变成 `diy(~) [test]`：看着像用户家目录，其实是个 /tmp 临时根。
//
// 例：`diy(~/git/diy/_diy.worktrees/instance-title/build/home) [dev] feat/instance-title :18888 pid 4242`
//     `diy(/tmp/diy-app-test-abc123) [test] feat/instance-title :52341 pid 53087`

/** 应用名（标题前缀） */
export const APP_NAME = "diy";

/**
 * 非生产环境的后缀标签。生产不带后缀 —— 日常用的就是生产，多余文字只是噪音；
 * dev/test 必须露出来：它们的界面与生产几乎一样，但数据与某些能力完全不同。
 */
const ENV_LABEL: Record<string, string> = {
  development: "dev",
  test: "test",
};

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
  /** 数据根（DIY_HOME）的展示形式：绝对路径，或相对**真实家目录**的 `~/…` */
  homeDisplay: string;
  /** 运行环境（production/development/test） */
  env: string;
  /** 当前运行代码所在 git 分支（拿不到时省略） */
  branch?: string | null;
  /** RPC 端口（尚未绑定 / 未知时省略） */
  port?: number | null;
  /** 进程 PID */
  pid?: number | null;
}

/**
 * 组装窗口标题：
 *   `diy(<数据根>) [环境] <分支> :<端口> pid <PID>`
 *
 * 字段顺序 = 排查时的阅读顺序：先认出「哪个实例」（数据根 + 环境），
 * 再认出「哪份代码」（分支），最后拿到「哪个进程」（端口 + PID）。
 * 数据根为空时退化成 `diy(?)` —— 宁可显示一个显眼的问号，也不显示成像是生产默认值。
 */
export function instanceTitle(id: InstanceIdentity): string {
  const parts = [`${APP_NAME}(${id.homeDisplay || "?"})`];
  const label = ENV_LABEL[id.env];
  if (label) parts.push(`[${label}]`);
  if (id.branch) parts.push(id.branch);
  if (id.port) parts.push(`:${id.port}`);
  if (id.pid) parts.push(`pid ${id.pid}`);
  return parts.join(" ");
}
