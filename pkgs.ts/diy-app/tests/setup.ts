import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { sweepStaleTestHomes } from "./temp-home";

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
// 声明测试环境：runtime.ts 据此派生 dev/test 专属能力（窗口定位副屏等），生产能力一律关闭
process.env["DIY_ENV"] = "test";
// 变体根：测试实例独占 build/test/**（产物由 `sha.sh test-intent` 的 `DIY_VARIANT=test build` 出）。
// 在这里兜底，直接跑 `npx vitest run tests/cli.intent` 也能命中（不必依赖外层 export）。
process.env["DIY_VARIANT"] ??= "test";
// 禁止 CLI 自动拉起 app：测试自己用 startElectronTest 启动实例并持有句柄，
// CLI 若在端口探测超时时另起 detached 实例，测试无法回收 → 进程泄露。
// 注入点选这里而非各测试文件：ShellTest 的 env = { ...process.env, ...opts.env }，
// 在此设一次即对所有 CLI 调用生效（见 shell-test.ts:43）。
process.env["DIY_NO_LAUNCH"] = "1";

// ── 模型目录夹具（生产无内置 provider；单测注入一份「已配置 opencode-go」） ──
// 见 tests/fixtures/models.ts。注入后 findModel/apiOf/reasoningOf 等对这套模型可用。
import { setModelCatalog } from "../src/shared/models";
import { OPENCODE_GO_SNAPSHOT, FIXTURE_DEFAULT_REF } from "./fixtures/models";
setModelCatalog(OPENCODE_GO_SNAPSHOT);
// 缺省人物指向一个可用模型：core 单测（compact/steer…）走真链时 persona.model 必须解析得到。
// 生产不写这份兜底（用户需自行配置 provider 后建人物）。
writeFileSync(
    join(testHome, "personas.yaml"),
    `default: persona/1\npersonas:\n  persona/1:\n    name: 大副\n    model: ${FIXTURE_DEFAULT_REF}\n    reasoningEffort: medium\n    instructions: ""\n`,
);

// 顺手清扫历史残留的隔离 HOME：删「系统临时目录下、超过 24h 未动」的本套件目录。
// 按 mtime 判龄 → 并发跑的其它 worktree 的活跃目录不会被误删。失败静默。
// 注：放在 env 隔离**之后**执行（本模块已把 HOME 指向隔离目录，不影响 tmpdir）。
{
  const n = sweepStaleTestHomes();
  if (n > 0) console.log(`[setup] 清扫 ${n} 个过期测试临时目录（>24h）`);
}
