import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ═══════════════════════════════════════════════
// 🛡️ 安全：每次测试运行分配一次性临时目录
//    测试代码读 process.env.DIY_HOME 时指向此处
//    绝不可能触及 ~/.diy/ 的生产数据
//    测试目录不删除（防 rm -rf 生产数据事故）
// ═══════════════════════════════════════════════

const testHome = mkdtempSync(join(tmpdir(), "diy-desktop-test-"));
process.env["DIY_HOME"] = testHome;
