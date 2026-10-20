// tests/cli.intent.env-disk.test.ts
// ═══════════════════════════════════════════════════════════════
// ##384「环境感知」的**真卷活体** —— 真填一个真卷、真读 `statfs`、真亮红条。
//
// 为什么单独一个文件（而不是并入 `cli.intent.env-bar`）：那个文件走 `env simulate`（注入假事实），
// 本文件走**真卷 + 真水位**（`fs.statfs` 直接采），二者要的实例环境不同（本文件要
// `DIY_ENV_WATCH_TARGET` / `DIY_ENV_DISK_POLL_MS` 在**启动期**注入）。
//
// ⚠️ 铁律：**绝不填满根卷**（2026-10-18 满盘把 ##166 正文写成 0 字节）。这里用的是
// `hdiutil` 造的**独立小镜像**（挂 `/Volumes/<唯一名>`），填它只影响它自己，跑完 `-force` 卸载 +
// 删 dmg。危险动作全部限定在自己造的卷上。
//
// 默认规模 16 MiB（秒级、零风险）：验「真水位 → 红条 + 数字与 `df` 一致 + ✕ 后不再回放」。
// **真恢复自动消**需要"空卷本身就算充足"（> `low` 阈值 2 GiB），故用 opt-in 的大镜像跑一次：
//   `DIY_ENV_DISK_PROBE_MB=3400 ./sha.sh test-intent env-disk`
// （3400 MiB 稀疏镜像：空卷 → ok；填掉 ~3.1 GiB → full；删文件 → ok ⇒ 验真恢复路径。
//   跑完镜像即删，占用回到零。）
// ═══════════════════════════════════════════════════════════════

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ShellTest } from "./shell-test";
import { startElectronTest, type ElectronTest } from "./electron-test";
import { waitUntil } from "./wait";
import { makeUiDriver, type UiDriver } from "./ui-drive";

/** 镜像规模（MiB）：缺省 16（秒级）；大值 = 跑真恢复路径（见文件头） */
const PROBE_MB = Number(process.env["DIY_ENV_DISK_PROBE_MB"] ?? 16);
/** 空卷即判 `ok` 才谈得上"恢复"（> low 阈值 2 GiB） */
const CAN_RECOVER = PROBE_MB > 2560;
/** 填充量：留 ~256 MiB（< full 阈值 512 MiB ⇒ 必判 full），小卷则整卷灌满 */
const FILL_MB = Math.max(1, PROBE_MB - 256);

const HAS_HDIUTIL = (() => {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("which", ["hdiutil"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const VOL = `t384probe-${process.pid}`;
const MOUNT = `/Volumes/${VOL}`;
const DMG = join(tmpdir(), `${VOL}.dmg`);

let fx: { sh: ShellTest; HOME: string; electron: ElectronTest };
let ui: UiDriver;

/** 卸载 + 删镜像（幂等；前后都调，免得上一次跑挂了留下残骸） */
function destroyImage(): void {
  try {
    execFileSync("hdiutil", ["detach", MOUNT, "-force"], { stdio: "ignore" });
  } catch {
    /* 没挂载就没什么可卸 */
  }
  if (existsSync(DMG)) rmSync(DMG, { force: true });
}

const envList = async () => JSON.parse((await fx.sh.run("./diy.sh env list")).stdout) as Array<{
  id: string;
  type: string;
  level: string;
  data: { dev: number | null; mount: string; availBytes: number; totalBytes: number };
}>;

/** `df -k <卷>` 的可用 KB（**独立工具**核数字：不能只看自己算的 statfs，否则是自证） */
async function dfAvailKb(): Promise<number> {
  const r = await fx.sh.run(`df -k ${MOUNT}`);
  const row = r.stdout.trim().split("\n").find((l) => l.includes(MOUNT)) ?? "";
  return Number(row.trim().split(/\s+/)[3]);
}

describe.skipIf(!HAS_HDIUTIL)("##384 真卷活体（hdiutil 小镜像，绝不碰根卷）", () => {
  beforeAll(async () => {
    destroyImage();
    execFileSync("hdiutil", ["create", "-size", `${PROBE_MB}m`, "-fs", "HFS+", "-volname", VOL, "-quiet", DMG]);
    execFileSync("hdiutil", ["attach", DMG, "-nobrowse"], { stdio: "ignore" });
    // 启动期注入（poller 在首次 env.* 调用时读它；间隔压到 1s 让用例秒级）
    process.env["DIY_ENV_WATCH_TARGET"] = MOUNT;
    process.env["DIY_ENV_DISK_POLL_MS"] = "1000";
    const electron = await startElectronTest();
    const HOME = electron.home;
    fx = {
      electron,
      HOME,
      sh: new ShellTest({ cwd: join(__dirname, "..", "..", ".."), env: { HOME, DIY_HOME: HOME } }),
    };
    ui = await makeUiDriver(electron.cdpUrl, async () => {
      const r = await fx.sh.getJson("./diy.sh ui inspect");
      return ((r.data as Record<string, unknown>)?.data as Record<string, unknown>)?.tree as never;
    });
  }, 120_000);

  afterAll(async () => {
    ui?.close();
    await fx?.electron?.stop();
    destroyImage();
    delete process.env["DIY_ENV_WATCH_TARGET"];
    delete process.env["DIY_ENV_DISK_POLL_MS"];
  });

  it("真填满小卷 → 轮询自己发现并亮 disk-full，数字与 `df -k` 一致", async () => {
    // dd 灌满（末一次必然 ENOSPC 退出非 0 —— 那正是我们要的真实条件）
    await fx.sh.run(`dd if=/dev/zero of=${MOUNT}/fill bs=1m count=${FILL_MB}`, 120_000);
    const rows = await waitUntil(envList, (v) => v.some((n) => n.type === "disk-full"), {
      label: "轮询发现真满盘",
      timeoutMs: 20_000,
    });
    expect(rows.find((n) => n.type === "disk-full")!.level).toBe("error");
    // 数字与**独立工具** df 一致（自己算的 statfs 与自己比 = 自证，不算验）。
    //
    // ⚠️ 必须等"写完之后的采样"：dd 跑的过程中就会跨过阈值，第一条通知的数字可能取自写入中
    // （实测大镜像下差 40 MiB）—— 那是**正确行为**（那一刻确实剩这么多），只是不该拿去和
    // 写完之后才跑的 df 比。故等到「通知数字 ↔ 当轮 df」对上为止。
    const { row, kb } = await waitUntil(
      async () => {
        const [list, k] = [await envList(), await dfAvailKb()];
        return { row: list.find((n) => n.type === "disk-full"), kb: k };
      },
      (v) => !!v.row && Math.abs(v.row.data.availBytes - v.kb * 1024) < 64 * 1024,
      { label: "通知数字与 df 一致（等写入结束后的那次采样）", timeoutMs: 20_000 },
    );
    expect(row!.data.mount).toBe(MOUNT);
    // 槽键是**卷标识**（review2 R1）：镜像挂在 /Volumes/t384-probe 上，dev 必须与根卷不同 ——
    // 否则「多卷各占一槽」在真路径上不成立（而 bar 会把两个卷合并成一条）
    expect(typeof row!.data.dev).toBe("number");
    expect(row!.data.dev).not.toBe(statSync("/").dev);
    expect(kb * 1024).toBeLessThan(512 * 1024 ** 2); // 确实在 full 阈值之下
    // `env probe <path>`（探针入口，AGENTS.md 里写了它）：指定路径现采一次 —— 数字同样要对得上 df
    const p = await fx.sh.getJson(`./diy.sh env probe --path ${MOUNT}`);
    const sample = (p as any).data?.sample as { dev: number | null; mount: string; availBytes: number; totalBytes: number };
    expect(sample.mount).toBe(MOUNT);
    expect(Math.abs(sample.availBytes - kb * 1024)).toBeLessThan(64 * 1024);
    // 真 red bar
    const s = await waitUntil(
      () =>
        ui.query<{ types: string[]; text: string }>(`(() => {
          const root = document.querySelector('[data-env-status-bar]');
          if (!root) return { types: [], text: '' };
          return {
            types: [...root.querySelectorAll('[data-env-status-bar-item]')].map((el) => el.getAttribute('data-env-status-bar-item')),
            text: root.textContent || '',
          };
        })()`),
      (v) => v.types.includes("disk-full"),
      { label: "真卷 disk-full 红条", timeoutMs: 8000 },
    );
    expect(s.text).toContain(MOUNT);
    expect(s.text).toContain("腾空间");
  }, 120_000);

  it("✕ 关掉后**轮询不把它弹回来**（条件不变不弹；这是真轮询在推，不是模拟）", async () => {
    const before = await envList();
    expect(before.length).toBeGreaterThan(0);
    const id = before[0]!.id;
    const d = await fx.sh.run(`./diy.sh env dismiss ${id}`);
    const after = await envList();
    // 失败时把 CLI 的退出码与输出一并报出来（排查不靠猜）
    expect(after, `dismiss ${id} exit=${d.code} out=${d.stdout} err=${d.stderr} after=${JSON.stringify(after)}`).toHaveLength(0);
    // 等两轮轮询（间隔 1s）：真轮询每轮都会重新采到"满"，静音闸门必须拦住它
    await new Promise((r) => setTimeout(r, 2600));
    expect(await envList()).toHaveLength(0);
    const s = await ui.query<{ types: string[] }>(`(() => {
      const root = document.querySelector('[data-env-status-bar]');
      return { types: root ? [...root.querySelectorAll('[data-env-status-bar-item]')].map((el) => el.getAttribute('data-env-status-bar-item')) : [] };
    })()`);
    expect(s.types).not.toContain("disk-full");
  }, 60_000);

  it.skipIf(!CAN_RECOVER)("真腾出空间 → **自动消**（不要用户手动关）", async () => {
    // 上一用例已把该槽静音：清掉填充文件后水位回 ok —— 恢复时静音解除、红条消失
    await fx.sh.run(`rm -f ${MOUNT}/fill`);
    const rows = await waitUntil(envList, (v) => v.length === 0, { label: "腾空间后自动消", timeoutMs: 20_000 });
    expect(rows).toHaveLength(0);
    const kb = await dfAvailKb();
    expect(kb * 1024).toBeGreaterThan(2 * 1024 ** 3); // 确实回到了 low 阈值之上
  }, 120_000);
});
