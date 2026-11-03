// Ed25519 密钥 / Token 哈希。
//
// 只用 `node:crypto`（Ed25519 是 Node 内建能力），不引第三方曲线库。
// 私钥永远是 base64(PKCS8 DER)，只在内存与钥匙串之间流动；落盘的只有公钥。
// ##513：加了指纹（协议 B 的信任根 = 人眼比对的短指纹，不靠 CA）。

import {
    createHash,
    createHmac,
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    randomBytes,
    sign,
    timingSafeEqual,
    verify,
} from 'node:crypto';

export interface KeyPair {
    /** base64(SPKI DER) */
    publicKey: string;
    /** base64(PKCS8 DER) —— **只进钥匙串** */
    privateKey: string;
}

export function generateKeyPair(): KeyPair {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    return { publicKey: pub, privateKey: priv };
}

export function signMessage(privateKeyBase64: string, message: string | Buffer): string {
    const key = createPrivateKey({ key: Buffer.from(privateKeyBase64, 'base64'), format: 'der', type: 'pkcs8' });
    return sign(null, typeof message === 'string' ? Buffer.from(message) : message, key).toString('base64');
}

export function verifyMessage(publicKeyBase64: string, message: string | Buffer, signatureBase64: string): boolean {
    try {
        const key = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' });
        return verify(
            null,
            typeof message === 'string' ? Buffer.from(message) : message,
            key,
            Buffer.from(signatureBase64, 'base64'),
        );
    } catch {
        return false;
    }
}

/** HMAC-SHA256 → hex（邀请码落盘用；**不存明文、不用无盐 SHA**，判据 14） */
export function hmacSha256Hex(secretKey: string, message: string): string {
    return createHmac('sha256', secretKey).update(message).digest('hex');
}

/** 常量时间比较两个 hex 串（长度不同直接 false，不抛） */
export function safeEqualHex(a: string, b: string): boolean {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

export function sha256Hex(input: string | Buffer): string {
    return createHash('sha256').update(input).digest('hex');
}

/**
 * 公钥指纹：SHA-256(SPKI DER) 的前 3 字节 → 6 位大写 hex（`3F9A2C`）。
 *
 * 协议 B 里人比的就是这 6 位（主控屏幕 ↔ 卫星屏幕）。比 base64 公钥短得多，
 * 口述 6 个 hex 字符也不容易错；安全性靠 SHA-256 原像，6 位只用于**人眼比对**。
 */
export function fingerprintOf(publicKeyBase64: string): string {
    const der = Buffer.from(publicKeyBase64, 'base64');
    if (der.length === 0) throw new Error('publicKey 不是合法的 base64 公钥');
    return createHash('sha256').update(der).digest('hex').slice(0, 6).toUpperCase();
}

/**
 * 64 个易读词（拼音，无同音混淆）—— 指纹的「念出来」形态。
 *
 * 手势：取 SHA-256(SPKI DER) 前 3 字节，每个字节取低 6 位当索引，得 3 个词。
 * 词表下标稳定、算法纯函数：同一把公钥永远得到同一组词（判据 6）。
 */
export const FINGERPRINT_WORDS = [
    'an', 'bai', 'bei', 'bo', 'cai', 'chen', 'chi', 'chun',
    'da', 'dan', 'dao', 'deng', 'dong', 'du', 'er', 'fang',
    'fei', 'feng', 'fu', 'gan', 'gao', 'ge', 'gu', 'gui',
    'hai', 'han', 'hao', 'he', 'hong', 'hu', 'hua', 'hui',
    'ji', 'jia', 'jian', 'jin', 'jing', 'ju', 'kai', 'ke',
    'lan', 'li', 'lin', 'long', 'lu', 'ma', 'mei', 'ming',
    'nan', 'ni', 'ping', 'qi', 'qing', 'shan', 'shui', 'song',
    'tai', 'tian', 'wang', 'wen', 'wu', 'xia', 'xin', 'yun',
] as const;

/** 指纹的词形态（`chen hui yun`）：电话里念、纸上抄都比 hex 抗错 */
export function fingerprintWords(publicKeyBase64: string): string {
    const der = Buffer.from(publicKeyBase64, 'base64');
    if (der.length === 0) throw new Error('publicKey 不是合法的 base64 公钥');
    const digest = createHash('sha256').update(der).digest();
    return [0, 1, 2].map((i) => FINGERPRINT_WORDS[digest[i]! & 0x3f]!).join(' ');
}

/** 32 字节随机 Token（base64url，无填充；进钥匙串，不落盘） */
export function generateToken(): string {
    return randomBytes(32).toString('base64url');
}

/** 32 字节随机 id（requestId / membershipId；不可猜，所以可作 bearer 凭据用） */
export function newId(prefix: string): string {
    return `${prefix}_${randomBytes(16).toString('base64url')}`;
}
