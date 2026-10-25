// 真样例束：全部取自仓库现有事实（##404 讨论时点的实测值），不是编的例子。
// 用途：把这套判据压到真数据上，看会不会误判冲突 / 误报悬空。

import type { Fact } from '../../src/types';

const verified = { source: 'probe', probe: 'node scripts/probe-port.mjs', verifiedAt: '2026-10-21' } as const;

export const realFacts: readonly Fact[] = [
    // ① 同一 claim 两个 scope 变体：production=18888 / dev·test=0（runtime.ts::defaultPort）
    {
        id: 'port.production',
        subject: 'app.port',
        aspect: 'default',
        value: '18888',
        scope: { env: 'production' },
        review: 'accepted',
        lifecycle: 'active',
        evidence: { ...verified, probeDigest: 'sha256:9f1c' },
    },
    {
        id: 'port.dev-test',
        subject: 'app.port',
        aspect: 'default',
        value: '0',
        scope: { env: ['development', 'test'] },
        review: 'accepted',
        lifecycle: 'active',
        evidence: { ...verified, probeDigest: 'sha256:9f1c' },
    },
    // ② 依赖 claim：env.port 的优先级链（跨环境取正确变体，而不是写死 18888）
    {
        id: 'env.port',
        subject: 'env.port',
        aspect: '优先级',
        value: 'DIY_PORT > app.port 文件 > defaultPort(env)',
        review: 'accepted',
        lifecycle: 'active',
        evidence: { source: 'code', at: 'pkgs.ts/diy-app/src/runtime.ts:11' },
        refs: [{ rel: 'depends-on', data: { toClaim: 'app.port#default' } }],
    },
    // ③ 边自身带 scope 谓词：serve 例外只在 production 兜 18888
    {
        id: 'serve.port',
        subject: 'serve.port',
        aspect: '兜底',
        value: '18888',
        review: 'accepted',
        lifecycle: 'active',
        evidence: { source: 'code', at: 'pkgs.ts/diy-app/src/serve/index.ts:1' },
        refs: [
            {
                rel: 'depends-on',
                data: { toClaim: 'app.port#default', when: { env: 'production' } },
            },
        ],
    },
    // ④ path scope（与 variant 无关）：测试纪律按目录生效
    {
        id: 'rule.test-bail',
        subject: 'rule.test-bail',
        aspect: '落点',
        value: 'bail:1（撞红即停，回报须写清范围）',
        scope: { paths: ['pkgs.ts/diy-app/tests'] },
        review: 'accepted',
        lifecycle: 'active',
        evidence: { source: 'code', at: 'pkgs.ts/diy-app/vitest.config.ts:1' },
    },
    // ⑤ 漂移的真实形态：旧值被替代后仍留档（lifecycle=superseded）
    {
        id: 'model.default.v1',
        subject: 'model.default',
        aspect: '缺省模型',
        value: 'mimo-v2.6-flash',
        review: 'accepted',
        lifecycle: 'superseded',
        evidence: { source: 'code', at: 'pkgs.ts/diy-app/src/shared/model-default.ts:1' },
    },
    {
        id: 'model.default.v2',
        subject: 'model.default',
        aspect: '缺省模型',
        value: 'mimo-v2.5（free 优先，一个都不可用才退它）',
        review: 'accepted',
        lifecycle: 'active',
        evidence: { source: 'code', at: 'pkgs.ts/diy-app/src/shared/model-default.ts:1' },
        refs: [{ rel: 'supersedes', data: { toFactId: 'model.default.v1' } }],
    },
];
