// 配置裁决的单测：数据根 / 端口 / 生产根判据 —— 这三条都是「错了不会报错，
// 只会静默用错数据」的类型，所以纯函数边界都钉住。
//
// 2026-11 改：`resolveConfig` 不再读 `DIY2_*` 环境变量，输入只有 `mode` + `overrides`。
// 于是这里有一条**回归测试**：设了 `DIY2_HOME` / `DIY2_PORT` / `DIY2_VARIANT` 也不影响结果
// —— 那是这次重构要消掉的东西（外层 shell 漏出来的变量曾经把 lab 写到生产数据根）。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    PROD_DEFAULT_PORT,
    buildRootOf,
    defaultLaunch,
    describeConfig,
    isProdHome,
    readPortFile,
    resolveConfig,
    resolveHome,
    resolvePort,
    serverEntryOf,
    webDirOf,
    writePortFile,
} from '../server/config';

const dirs: string[] = [];
function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'diy2-config-'));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 与 config.ts 同一口径：真实家目录（不读 $HOME）+ `.diy/diy2` */
function prodHome(): string {
    return join(userInfo().homedir, '.diy', 'diy2');
}

const APP_ROOT = join(import.meta.dirname, '..');

describe('defaultLaunch', () => {
    it('生产 prod、测试 test、其余 lab（staging 显式给）', () => {
        expect(defaultLaunch('production')).toBe('prod');
        expect(defaultLaunch('development')).toBe('lab');
        expect(defaultLaunch('test')).toBe('test');
    });
});

describe('isProdHome', () => {
    it('两个生产根都算（~/.diy 与 ~/.diy/diy2）', () => {
        expect(isProdHome(prodHome())).toBe(true);
        expect(isProdHome(join(userInfo().homedir, '.diy'))).toBe(true);
        expect(isProdHome('/tmp/whatever')).toBe(false);
    });
});

describe('resolvePort', () => {
    it('优先级：cli > 记录（非生产） > 缺省', () => {
        expect(resolvePort({ mode: 'development', cliPort: 6000, recordedPort: 6002 }).source).toBe('cli');
        expect(resolvePort({ mode: 'development', recordedPort: 6002 }).source).toBe('recorded');
        expect(resolvePort({ mode: 'development' }).source).toBe('default');
    });

    it('缺省：生产 5192，其余 0（内核分配）', () => {
        expect(resolvePort({ mode: 'production' })).toEqual({ port: PROD_DEFAULT_PORT, source: 'default' });
        expect(resolvePort({ mode: 'development' })).toEqual({ port: 0, source: 'default' });
        expect(resolvePort({ mode: 'test' })).toEqual({ port: 0, source: 'default' });
    });

    it('非生产不沿用记录里的 5192（那是生产门牌），其它记录照吃不误', () => {
        expect(resolvePort({ mode: 'development', recordedPort: PROD_DEFAULT_PORT }).port).toBe(0);
        expect(resolvePort({ mode: 'development', recordedPort: 5300 })).toEqual({ port: 5300, source: 'recorded' });
    });

    it('生产不沿用记录（门牌固定），但记录仍能当探活候选（见 index.ts）', () => {
        expect(resolvePort({ mode: 'production', recordedPort: 5300 }).port).toBe(PROD_DEFAULT_PORT);
    });

    it('--port 0 是显式表达「内核分配」，不能被缺省吃掉', () => {
        expect(resolvePort({ mode: 'production', cliPort: 0 })).toEqual({ port: 0, source: 'cli' });
    });
});

describe('resolveHome', () => {
    it('缺省：生产 ~/.diy/diy2；非生产 <appRoot>/build/<launch>/home', () => {
        expect(resolveHome({ mode: 'production', launch: 'prod', appRoot: '/w/apps/diy2' }).home).toBe(prodHome());
        expect(resolveHome({ mode: 'development', launch: 'lab', appRoot: '/w/apps/diy2' }).home).toBe(
            join('/w/apps/diy2', 'build', 'lab', 'home'),
        );
        expect(resolveHome({ mode: 'test', launch: 'test', appRoot: '/w' }).home).toBe(
            join('/w', 'build', 'test', 'home'),
        );
    });

    it('非生产拿到生产根 → 拒绝并回落缺省（静默写脏真库是更坏的结局）', () => {
        const result = resolveHome({ mode: 'development', launch: 'lab', appRoot: '/w', explicit: prodHome() });
        expect(result.home).toBe(join('/w', 'build', 'lab', 'home'));
        expect(result.rejected).toBe(prodHome());
    });

    it('显式 --allow-prod-home 才放行', () => {
        const allowed = resolveHome({
            mode: 'development',
            launch: 'lab',
            appRoot: '/w',
            explicit: prodHome(),
            allowProdHome: true,
        });
        expect(allowed.home).toBe(prodHome());
        expect(allowed.rejected).toBeNull();
    });

    it('生产拿生产根是正常语义（不拒）', () => {
        expect(
            resolveHome({ mode: 'production', launch: 'prod', appRoot: '/w', explicit: prodHome() }).rejected,
        ).toBeNull();
    });

    it('任意显式目录照用（沙箱 / 临时目录）', () => {
        const dir = tmp();
        expect(resolveHome({ mode: 'development', launch: 'lab', appRoot: '/w', explicit: dir }).home).toBe(dir);
    });
});

describe('产物目录（固定 build/prod，不跟 launch 走）', () => {
    it('buildRoot / webDir / serverEntry', () => {
        expect(buildRootOf('/w/apps/diy2')).toBe(join('/w/apps/diy2', 'build', 'prod'));
        expect(webDirOf('/w/apps/diy2')).toBe(join('/w/apps/diy2', 'build', 'prod', 'web'));
        expect(serverEntryOf('/w/apps/diy2')).toBe(join('/w/apps/diy2', 'build', 'prod', 'server', 'index.mjs'));
    });
});

describe('app.port 记录', () => {
    it('写 → 读；坏内容 / 非法端口 → null', () => {
        const dir = tmp();
        const file = join(dir, 'app.port');
        expect(readPortFile(file)).toBeNull();
        writePortFile(file, 5301);
        expect(readPortFile(file)).toBe(5301);

        writeFileSync(file, 'abc');
        expect(readPortFile(file)).toBeNull();
        writeFileSync(file, '99999');
        expect(readPortFile(file)).toBeNull();
    });

    it('resolveConfig：非生产有记录就吃，并把记录单独暴露给探活', () => {
        const home = tmp();
        writePortFile(join(home, 'app.port'), 5306);

        const config = resolveConfig({ moduleDir: APP_ROOT, mode: 'development', overrides: { home } });
        expect(config.port).toBe(5306);
        expect(config.portSource).toBe('recorded');
        expect(config.recordedPort).toBe(5306);
        expect(config.portFile).toBe(join(home, 'app.port'));
    });
});

describe('resolveConfig', () => {
    it('dev：环境 / 入口名 / 数据根 / 端口来源都从参数来', () => {
        const home = tmp();
        const config = resolveConfig({ moduleDir: APP_ROOT, mode: 'development', overrides: { home } });
        expect(config.env).toBe('development');
        expect(config.launch).toBe('lab');
        expect(config.home).toBe(home);
        expect(config.dbPath).toBe(join(home, 'diy2.db'));
        expect(config.port).toBe(0);
        expect(config.portSource).toBe('default');
        expect(config.app).toBe('diy2');
        expect(describeConfig(config)).toContain(home);
        expect(describeConfig(config)).toContain('/lab ');
    });

    it('**不读** DIY2_* 环境变量（回归：外层 shell 漏出来的变量不许改配置）', () => {
        const home = tmp();
        const polluted = { DIY2_HOME: home, DIY2_PORT: '5399', DIY2_VARIANT: 'staging', DIY2_ENV: 'production' };
        const saved: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(polluted)) {
            saved[key] = process.env[key];
            process.env[key] = value;
        }
        try {
            const config = resolveConfig({
                moduleDir: APP_ROOT,
                mode: 'development',
                overrides: { launch: 'lab' },
            });
            expect(config.home).toBe(join(APP_ROOT, 'build', 'lab', 'home'));
            expect(config.port).toBe(0);
            expect(config.env).toBe('development');
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });

    it('命令行端口优先级最高（--port 0 也能显式表达内核分配）', () => {
        const home = tmp();
        const config = resolveConfig({
            moduleDir: APP_ROOT,
            mode: 'development',
            overrides: { home, port: 5302 },
        });
        expect(config.port).toBe(5302);
        expect(config.portSource).toBe('cli');
    });

    it('被拒的生产根变成一条 note（入口负责打出来，不静默）', () => {
        const config = resolveConfig({
            moduleDir: APP_ROOT,
            mode: 'development',
            overrides: { home: prodHome() },
        });
        expect(config.home).toBe(join(APP_ROOT, 'build', 'lab', 'home'));
        expect(config.notes.join('\n')).toContain('拒绝非生产入口使用生产数据根');
    });

    it('webDir：产物在就有，不在就 undefined；noWeb 强制不要', () => {
        const appRoot = tmp();
        // 造一个最小的包目录（findAppRoot 认 package.json 的 name）
        writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: '@diy-agent/app-diy2' }));
        expect(resolveConfig({ moduleDir: appRoot, mode: 'development' }).webDir).toBeUndefined();

        mkdirSync(join(appRoot, 'build', 'prod', 'web'), { recursive: true });
        expect(resolveConfig({ moduleDir: appRoot, mode: 'development' }).webDir).toBe(
            join(appRoot, 'build', 'prod', 'web'),
        );
        expect(
            resolveConfig({ moduleDir: appRoot, mode: 'development', overrides: { noWeb: true } }).webDir,
        ).toBeUndefined();
    });

    it('appRoot 找得到（从 tests/ 向上）、obj 里有 repoRoot', () => {
        const config = resolveConfig({ moduleDir: APP_ROOT, mode: 'production' });
        expect(config.appRoot.endsWith(join('apps', 'diy2'))).toBe(true);
        expect(config.buildRoot).toBe(join(config.appRoot, 'build', 'prod'));
    });

    it('tools / 压缩预算来自参数', () => {
        const config = resolveConfig({
            moduleDir: APP_ROOT,
            mode: 'development',
            overrides: { home: tmp(), tools: 'files', compactKeep: 3, compactChars: 5000 },
        });
        expect(config.tools).toBe('files');
        expect(config.compact).toEqual({ keepLast: 3, maxChars: 5000 });
    });
});
