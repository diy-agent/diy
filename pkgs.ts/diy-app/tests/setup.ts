import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

// ═══════════════════════════════════════════════
// 🛡️ 安全：每次测试运行分配一次性临时目录
//    测试代码读 process.env.DIY_HOME 时指向此处
//    绝不可能触及 ~/.diy/ 的生产数据
//    测试目录不删除（防 rm -rf 生产数据事故）
// ═══════════════════════════════════════════════

const testHome = mkdtempSync(join(tmpdir(), "diy-desktop-test-"));

// 真实 home 先留档再覆盖：后面若需要"用户真实配置"（如 electron-test 的符号链接源），
// 必须用这个值——homedir() 在本文件执行后已指向隔离目录。
process.env["DIY_REAL_HOME"] = process.env["HOME"] ?? homedir();

// HOME 与 DIY_HOME 必须一起隔离，只隔离后者是半成品：
//   expandPath("~/...") 用 homedir() 展开（src/main/core/project.ts），
//   而 homedir() 在 POSIX 上读 $HOME —— 只隔离 DIY_HOME 时它会解析到真实家目录，
//   于是 removeProject 会按 meta.yaml 里的 `path: ~/git/...` 去真实仓库摘 diy.yaml 名片，
//   单测进程内直接调 removeProject/deleteTask 就能写坏生产数据。
process.env["HOME"] = testHome;
process.env["DIY_HOME"] = testHome;
// 端口由入口注入，不再由 isTemp 派生：测试用 0=随机端口，避免与生产 18888 冲突
process.env["DIY_PORT"] = "0";
// 自动化测试窗口强制副屏，避免频繁启动遮挡主屏工作
process.env["_DIY_MIRROR_DISPLAY"] = "1";
// 禁止 CLI 自动拉起 app：测试自己用 startElectronTest 启动实例并持有句柄，
// CLI 若在端口探测超时时另起 detached 实例，测试无法回收 → 进程泄露。
// 注入点选这里而非各测试文件：ShellTest 的 env = { ...process.env, ...opts.env }，
// 在此设一次即对所有 CLI 调用生效（见 shell-test.ts:43）。
process.env["DIY_NO_LAUNCH"] = "1";
