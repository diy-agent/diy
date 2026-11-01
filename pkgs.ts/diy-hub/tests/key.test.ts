// 判据 12：Hub 私钥只在钥匙串，hub.json 只有公钥。
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { generateKeyPair, signMessage, verifyMessage } from '../src/key.js';
import { hubIdentityFile, initHubIdentity, loadHubIdentity, loadHubPrivateKey } from '../src/hub.js';
import { cleanupTempDirs, memorySecrets, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

describe('Ed25519 与身份', () => {
    it('签名 / 验签', () => {
        const pair = generateKeyPair();
        const sig = signMessage(pair.privateKey, 'hello hub');
        expect(verifyMessage(pair.publicKey, 'hello hub', sig)).toBe(true);
        expect(verifyMessage(pair.publicKey, 'hello hub!', sig)).toBe(false);
    });

    it('init 把私钥写进钥匙串，hub.json 只有公钥（判据 12）', async () => {
        const home = tempDir();
        const secrets = memorySecrets();
        const identity = await initHubIdentity({ home, secrets, hubNodeId: 'diy-hub01' });

        const file = hubIdentityFile(home);
        const raw = readFileSync(file, 'utf-8');
        const parsed = JSON.parse(raw);
        expect(parsed.publicKey).toBe(identity.publicKey);
        expect(raw).not.toContain('privateKey');
        expect(raw).not.toContain('PRIVATE');
        expect(await secrets.get('hub-private-key')).toBeTruthy();
    });

    it('重复 init 不换密钥（换了等于全部重配）', async () => {
        const home = tempDir();
        const secrets = memorySecrets();
        const first = await initHubIdentity({ home, secrets, hubNodeId: 'diy-hub01' });
        const second = await initHubIdentity({ home, secrets, hubNodeId: 'diy-hub01' });
        expect(second.publicKey).toBe(first.publicKey);
        expect(await loadHubIdentity(home)).toEqual(first);
        expect(await loadHubPrivateKey(secrets)).toBeTruthy();
    });

    it('init --endpoint 只更新地址，不换密钥', async () => {
        const home = tempDir();
        const secrets = memorySecrets();
        const first = await initHubIdentity({ home, secrets, hubNodeId: 'diy-hub01' });
        const updated = await initHubIdentity({
            home,
            secrets,
            hubNodeId: 'diy-hub01',
            endpoint: 'https://c-mac.gute-fish.ts.net/hub',
        });
        expect(updated.publicKey).toBe(first.publicKey);
        expect(updated.endpoint).toBe('https://c-mac.gute-fish.ts.net/hub');
        expect((await loadHubIdentity(home)).endpoint).toBe('https://c-mac.gute-fish.ts.net/hub');
    });

    it('hub.json 在但钥匙串丢了私钥 → 明确报错，不静默换钥', async () => {
        const home = tempDir();
        await initHubIdentity({ home, secrets: memorySecrets(), hubNodeId: 'diy-hub01' });
        await expect(initHubIdentity({ home, secrets: memorySecrets(), hubNodeId: 'diy-hub01' })).rejects.toThrow(
            /钥匙串/,
        );
    });
});
