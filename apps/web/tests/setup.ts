// tests/setup.ts — 把实例注册表隔离到临时目录。
//
// 为什么必须有：`startWebServer` 启动时会写 `~/.diy-instances/<pid>.json`（##495 自报）。
// 不隔离的话：每个测试实例都往**真实家目录**写条目（测试进程被 SIGKILL 时还会留垃圾），
// 而且同 worker 的各测试文件会互相看见、地址凭空多出端口。`DIY_INSTANCE_REGISTRY`
// 是读侧（localDiscoverer）与写侧（apps/web/registry.ts）共用的那个覆盖口。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'app-web-instances-'));
process.env['DIY_INSTANCE_REGISTRY'] = dir;

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});
