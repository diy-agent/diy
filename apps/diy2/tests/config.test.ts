import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    PROD_DEFAULT_PORT,
    describeConfig,
    defaultVariant,
    parseEnv,
    readPortFile,
    removePortFile,
    resolveConfig,
    resolveHome,
    resolvePort,
    writePortFile,
    writeStickyPort,
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

describe('parseEnv', () => {
    it('只认三态，其余按 production（宁可少开能力）', () => {
        expect(parseEnv('development')).toBe('development');
        expect(parseEnv('dev')).toBe('development');
        expect(parseEnv('TEST')).toBe('test');
        expect(parseEnv('production')).toBe('production');
        expect(parseEnv(undefined)).toBe('production');
        expect(parseEnv('prod')).toBe('production');
        expect(parseEnv('  ')).toBe('production');
    });
});

describe('defaultVariant', () => {
    it('生产 prod，其余 lab', () => {
        expect(defaultVariant('production')).toBe('prod');
        expect(defaultVariant('development')).toBe('lab');
        expect(defaultVariant('test')).toBe('lab');
    });
});

describe('resolvePort', () => {
    it('优先级：cli > env > 记录 > 缺省', () => {
        expect(resolvePort({ env: 'production', cliPort: 6000, envPort: 6001, recordedPort: 6002 }).source).toBe('cli');
        expect(resolvePort({ env: 'production', envPort: 6001, recordedPort: 6002 }).source).toBe('env');
        expect(resolvePort({ env: 'production', recordedPort: 6002 }).source).toBe('recorded');
        expect(resolvePort({ env: 'production' }).source).toBe('default');
    });

    it('生产缺省 5192；dev/test 缺省 0（内核分配）', () => {
        expect(resolvePort({ env: 'production' })).toEqual({ port: PROD_DEFAULT_PORT, source: 'default' });
        expect(resolvePort({ env: 'development' })).toEqual({ port: 0, source: 'default' });
        expect(resolvePort({ env: 'test' })).toEqual({ port: 0, source: 'default' });
    });

    it('非生产不吃记录里的 5192（否则 dev 把生产门牌占住）', () => {
        expect(resolvePort({ env: 'development', recordedPort: PROD_DEFAULT_PORT })).toEqual({
            port: 0,
            source: 'default',
        });
        // 其余记录照常沿用（端口稳定，便于人肉访问）
        expect(resolvePort({ env: 'development', recordedPort: 5300 })).toEqual({ port: 5300, source: 'recorded' });
        // 生产照单沿用
        expect(resolvePort({ env: 'production', recordedPort: 5300 }).port).toBe(5300);
    });

    it('非生产也不吃**环境变量**里的 5192（外层 shell 常从生产实例继承）', () => {
        expect(resolvePort({ env: 'development', envPort: PROD_DEFAULT_PORT })).toEqual({ port: 0, source: 'default' });
        expect(resolvePort({ env: 'test', envPort: PROD_DEFAULT_PORT })).toEqual({ port: 0, source: 'default' });
        // 显式 cli 仍然最高优先（真要 5192 就 --port 5192）
        expect(resolvePort({ env: 'development', cliPort: 5192, envPort: PROD_DEFAULT_PORT })).toEqual({
            port: 5192,
            source: 'cli',
        });
        // 非缺省的端口照常尊重
        expect(resolvePort({ env: 'development', envPort: 5400 })).toEqual({ port: 5400, source: 'env' });
    });
});

describe('resolvePort 的端口粘性', () => {
    it('活体记录 > 粘性记录 > 缺省', () => {
        expect(resolvePort({ env: 'development', recordedPort: 5302, stickyPort: 5303 })).toEqual({
            port: 5302,
            source: 'recorded',
        });
        expect(resolvePort({ env: 'development', stickyPort: 5303 })).toEqual({ port: 5303, source: 'sticky' });
        expect(resolvePort({ env: 'development' })).toEqual({ port: 0, source: 'default' });
        // 显式给的永远压过两层记录
        expect(resolvePort({ env: 'development', cliPort: 5304, stickyPort: 5303 }).source).toBe('cli');
        expect(resolvePort({ env: 'development', envPort: 5304, stickyPort: 5303 }).source).toBe('env');
    });

    it('粘性也不吃 5192；生产完全不读粘性（门牌固定）', () => {
        expect(resolvePort({ env: 'development', stickyPort: PROD_DEFAULT_PORT })).toEqual({
            port: 0,
            source: 'default',
        });
        expect(resolvePort({ env: 'test', stickyPort: PROD_DEFAULT_PORT }).source).toBe('default');
        // 生产：`--port` 是一次性的，不该被一次意外运行钉死
        expect(resolvePort({ env: 'production', stickyPort: 5303 })).toEqual({
            port: PROD_DEFAULT_PORT,
            source: 'default',
        });
    });
});

describe('resolveHome', () => {
    it('缺省跟变体走：<appRoot>/build/<variant>/home', () => {
        expect(resolveHome({ env: 'development', variant: 'lab', appRoot: '/w/apps/diy2' }).home).toBe(
            '/w/apps/diy2/build/lab/home',
        );
    });

    it('dev 拒绝继承来的生产根，并回报 rejected（调用方据此告警）', () => {
        const real = resolveHome({ env: 'development', variant: 'lab', appRoot: '/w', inherited: prodHome() });
        expect(real.home).toBe('/w/build/lab/home');
        expect(real.rejected).toBe(prodHome());

        // 显式放行
        const allowed = resolveHome({
            env: 'development',
            variant: 'lab',
            appRoot: '/w',
            inherited: prodHome(),
            allowProdHome: true,
        });
        expect(allowed.home).toBe(prodHome());
    });

    it('自定义 home 照旧透传（实验常用临时目录）', () => {
        expect(resolveHome({ env: 'development', variant: 'lab', appRoot: '/w', inherited: '/tmp/x' }).home).toBe(
            '/tmp/x',
        );
    });

    it('生产语义下不拦（那时生产根就是对的）', () => {
        expect(resolveHome({ env: 'production', variant: 'prod', appRoot: '/w', inherited: prodHome() }).home).toBe(
            prodHome(),
        );
    });
});

/** 与 config.ts 同一口径：真实家目录（不读 $HOME）+ `.diy/diy2` */
function prodHome(): string {
    return join(userInfo().homedir, '.diy', 'diy2');
}

describe('app.port 记录', () => {
    it('写 → 读 → 删；坏内容 / 非法端口 → null', () => {
        const dir = tmp();
        const file = join(dir, 'app.port');
        expect(readPortFile(file)).toBeNull();
        writePortFile(file, 5301);
        expect(readPortFile(file)).toBe(5301);
        removePortFile(file);
        expect(readPortFile(file)).toBeNull();

        writeFileSync(file, 'abc');
        expect(readPortFile(file)).toBeNull();
        writeFileSync(file, '99999');
        expect(readPortFile(file)).toBeNull();
    });
});

describe('port.sticky 粘性记录', () => {
    it('写 → 读（复用 app.port 的信任规则）；**没有删除入口**（退出不删就是它的全部意义）', () => {
        const dir = tmp();
        const file = join(dir, 'port.sticky');
        expect(readPortFile(file)).toBeNull();
        writeStickyPort(file, 5305);
        expect(readPortFile(file)).toBe(5305);
    });

    it('resolveConfig：app.port 不在时吃粘性；两个都在时 app.port（活体）优先', () => {
        const home = tmp();
        writeStickyPort(join(home, 'port.sticky'), 5306);
        const env = { DIY2_ENV: 'development', DIY2_HOME: home };
        const moduleDir = join(import.meta.dirname, '..');

        const sticky = resolveConfig({ moduleDir, env });
        expect(sticky.port).toBe(5306);
        expect(sticky.portSource).toBe('sticky');
        expect(sticky.stickyPortFile).toBe(join(home, 'port.sticky'));

        writePortFile(join(home, 'app.port'), 5307);
        const recorded = resolveConfig({ moduleDir, env });
        expect(recorded.port).toBe(5307);
        expect(recorded.portSource).toBe('recorded');
    });
});

describe('resolveConfig', () => {
    it('dev：变体 / 环境 / 数据根 / 端口来源都从 DIY2_* 来', () => {
        const home = tmp();
        const config = resolveConfig({
            moduleDir: join(import.meta.dirname, '..'),
            env: { DIY2_ENV: 'development', DIY2_VARIANT: 'lab', DIY2_HOME: home },
        });
        expect(config.env).toBe('development');
        expect(config.variant).toBe('lab');
        expect(config.home).toBe(home);
        expect(config.dbPath).toBe(join(home, 'diy2.db'));
        expect(config.port).toBe(0);
        expect(config.portSource).toBe('default');
        expect(config.app).toBe('diy2');
        expect(describeConfig(config)).toContain(home);
    });

    it('命令行端口优先级最高（--port 0 也能显式表达内核分配）', () => {
        const home = tmp();
        const config = resolveConfig({
            moduleDir: join(import.meta.dirname, '..'),
            env: { DIY2_ENV: 'development', DIY2_HOME: home, DIY2_PORT: '5301' },
            cliPort: 5302,
        });
        expect(config.port).toBe(5302);
        expect(config.portSource).toBe('cli');
    });

    it('appRoot 找得到（从 server/ 向上）、不在仓库里时 repoRoot 为 null', () => {
        const config = resolveConfig({ moduleDir: join(import.meta.dirname, '..'), env: { DIY2_ENV: 'production' } });
        expect(config.appRoot.endsWith(join('apps', 'diy2'))).toBe(true);
    });
});
