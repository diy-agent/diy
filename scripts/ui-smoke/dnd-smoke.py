#!/usr/bin/env python3
"""dnd-smoke.py — UI 拖拽交互冒烟（Playwright/CDP 真实事件层）

验证 diy-app (Solid renderer) 的任务树拖拽手势：真实鼠标事件驱动真实 renderer，
抓 `diy.ui.*` handler 层测不到的 gesture bug（拖拽失效、isDropTarget 高亮、
点穿透、折叠状态、console/pageerror）。

用法：
    python3 scripts/ui-smoke/dnd-smoke.py
    python3 scripts/ui-smoke/dnd-smoke.py --cdp-port 9477 --keep

依赖：python3 + playwright（`pip install playwright`），diy-app 已 `npm run build`。
流程：启动隔离 Electron(--remote-debugging-port) → diy.sh 建项目/任务 →
Playwright connect_over_cdp 真实拖拽(任务↔任务改层级、子任务→项目提升) →
`diy ui tree` 断言层级 → 收尾 pkill Electron。全部通过 exit 0，否则非 0。
"""
import argparse, json, os, subprocess, sys, tempfile, time

# 仓库根 = <repo>/scripts/ui-smoke/<本文件> 上溯两级
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
APP = os.path.join(REPO, "pkgs.ts", "diy-app")
ELECTRON = os.path.join(REPO, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")


def run_diy(args, env, timeout=30):
    r = subprocess.run(["tsx", "src/cli/index.ts"] + args, cwd=APP, env=env,
                       capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def get_tree(env):
    """diy ui tree 有首连空响应 flake，重试拿完整 JSON 树。"""
    for _ in range(6):
        _, o, _ = run_diy(["ui", "tree", "--json"], env)
        if o.strip():
            try:
                return json.loads(o)["data"]["data"]
            except Exception:
                pass
        time.sleep(1)
    raise RuntimeError("diy ui tree 多次空响应")


def find_node(nodes, title):
    for n in nodes:
        if n.get("title") == title:
            return n
        r = find_node(n.get("children", []), title)
        if r:
            return r
    return None


def drag(pg, sx, sy, tx, ty, steps=6):
    """真实鼠标拖拽：按下 → 分步移动(过可拖区域/hover触发) → 释放。"""
    pg.mouse.move(sx, sy)
    pg.mouse.down()
    for i in range(1, steps + 1):
        pg.mouse.move(sx + (tx - sx) * i / steps, sy + (ty - sy) * i / steps)
        time.sleep(0.1)
    time.sleep(0.3)
    pg.mouse.up()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cdp-port", type=int, default=0, help="CDP 端口，默认取空闲随机端口")
    ap.add_argument("--keep", action="store_true", help="保留 Electron 实例退出（调试用）")
    args = ap.parse_args()

    home = tempfile.mkdtemp(prefix="diy-smoke-")
    env = dict(os.environ, HOME=home, DIY_HOME=home,
               PATH=REPO + "/node_modules/.bin:" + os.environ.get("PATH", ""))
    port = args.cdp_port or __import__("random").randint(9470, 9990)
    proc = subprocess.Popen([ELECTRON, "out/main/index.mjs", f"--remote-debugging-port={port}"],
                            cwd=APP, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(8)

    try:
        # ── fixture：1 项目 + 3 任务（甲根级、乙=甲子级、丙根级）──
        repo = os.path.join(home, "p")
        _, o, _ = run_diy(["project", "create", repo, "--label", "冒烟项目"], env)
        pid = json.loads(o)["data"]["id"]
        _, o, _ = run_diy(["task", "create", "根甲", str(pid)], env); t_a = json.loads(o)["data"]["uri"]
        _, o, _ = run_diy(["task", "create", "子乙", str(pid)], env); t_b = json.loads(o)["data"]["uri"]
        _, o, _ = run_diy(["task", "create", "根丙", str(pid)], env); t_c = json.loads(o)["data"]["uri"]
        run_diy(["task", "move", t_b, t_a], env)  # 子乙 = 根甲的子级

        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            b = p.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
            pg = b.contexts[0].pages[0]
            errors = []
            pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.reload()
            time.sleep(2)
            # 展开「根甲」显示其子级「子乙」
            pg.evaluate(
                "() => { const r=[...document.querySelectorAll('tbody tr')].find(x=>x.innerText.includes('根甲')); "
                "const b=[...r.querySelectorAll('button')].find(x=>['›','⌄'].includes(x.textContent.trim())); b&&b.click(); }"
            )
            time.sleep(0.5)

            def row(title):
                return pg.locator("tbody tr", has_text=title).first

            # 手势1：子乙 拖到 根丙 → 取消层级，成为根丙子级
            bb, cb = row("子乙").bounding_box(), row("根丙").bounding_box()
            drag(pg, 224 + 15, bb["y"] + bb["height"] / 2,
                 cb["x"] + cb["width"] * 0.3, cb["y"] + cb["height"] / 2)
            time.sleep(2)
            tree = get_tree(env)
            reparent_ok = find_node(tree, "子乙").get("parentUri") == t_c
            print(f"手势1 子乙→根丙 = 根丙子级: {'✓' if reparent_ok else '✗'}")

            # 手势2：子乙 拖到 冒烟项目 → 提升为一级
            pg.reload(); time.sleep(2)
            pg.evaluate(
                "() => { const r=[...document.querySelectorAll('tbody tr')].find(x=>x.innerText.includes('根丙')); "
                "const b=[...r.querySelectorAll('button')].find(x=>['›','⌄'].includes(x.textContent.trim())); b&&b.click(); }"
            )
            time.sleep(0.5)
            bb, pr = row("子乙").bounding_box(), row("冒烟项目").bounding_box()
            drag(pg, 224 + 15, bb["y"] + bb["height"] / 2,
                 pr["x"] + pr["width"] * 0.3, pr["y"] + pr["height"] / 2)
            time.sleep(2)
            tree = get_tree(env)
            proj_children = [c.get("title") for c in find_node(tree, "冒烟项目").get("children", [])]
            promote_ok = (find_node(tree, "子乙").get("parentUri") is None) and ("子乙" in proj_children)
            print(f"手势2 子乙→项目 = 提升一级: {'✓' if promote_ok else '✗'}")

        err_ok = not errors
        for e in errors:
            print("  console/pageerror:", e)
        print(f"console/pageerror 无: {'✓' if err_ok else '✗'}")
        ok = reparent_ok and promote_ok and err_ok
        print("\n冒烟结果:", "PASS" if ok else "FAIL")
        return 0 if ok else 1
    finally:
        if not args.keep:
            proc.kill()
            time.sleep(1)
            subprocess.run(["pkill", "-f", "out/main/index.mjs"], capture_output=True)


if __name__ == "__main__":
    sys.exit(main())