// src/shared/instance-title.ts
// 🎯 窗口标题 = 「这是哪个实例」的唯一标识（纯函数，main 与 renderer 共用一份实现）。
//
// 为什么需要：diy 允许多实例并行，各自的数据根（DIY_HOME）完全不同 ——
//   生产     ~/.diy
//   worktree <repo>/build/home（`./diy.sh` 的隔离数据根）
//   测试     mkdtemp 临时目录
// 此前标题只有 "diy solid"，切窗口 / macOS 标题栏 / dock 悬停全都认不出谁是谁，
// 排查「我这条命令打到哪个实例的数据」时只能靠猜。故标题直接写数据根。
//
// 为什么不带端口：同一 DIY_HOME 有单实例锁（main 的 requestSingleInstanceLock），
// 不会并存两个；跨实例的差异本来就在数据根上。端口体现在设置页「状态」里。

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
 * 只处理两种精确情形，不做「找最近的公共前缀」那种猜测：
 *   home === homeDir        → `~`
 *   home 在 homeDir 之下     → `~/...`
 * 其余（如测试的 /tmp/diy-desktop-test-xxx）原样返回 —— 它们本来就不在用户家目录下。
 */
export function abbrevHome(home: string, homeDir: string): string {
  if (!home) return "";
  const base = homeDir.replace(/\/+$/, "");
  if (!base) return home;
  if (home === base) return "~";
  if (home.startsWith(`${base}/`)) return `~${home.slice(base.length)}`;
  return home;
}

/**
 * 组装窗口标题：`diy(<数据根>)` + 非生产环境的后缀 `[dev]` / `[test]`。
 *
 * 例：`diy(~/.diy)`、`diy(~/.diy) [test]`、`diy(~/git/diy/diy/build/home) [dev]`
 * 数据根为空时退化成 `diy(?)` —— 宁可显示一个显眼的问号，也不显示成像是生产默认值。
 */
export function instanceTitle(homeDisplay: string, env: string): string {
  const base = `${APP_NAME}(${homeDisplay || "?"})`;
  const label = ENV_LABEL[env];
  return label ? `${base} [${label}]` : base;
}
