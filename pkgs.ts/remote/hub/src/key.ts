// Ed25519 密钥 / Token 哈希。
//
// 只用 `node:crypto`（Ed25519 是 Node 内建能力），不引第三方曲线库。
// 私钥永远是 base64(PKCS8 DER)，只在内存与钥匙串之间流动；落盘的只有公钥。
// v1 不做指纹核对（地址即身份，见协议备忘 §二），所以这里不提供指纹函数。

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

/** 32 字节随机 Token（base64url，无填充；进钥匙串，不落盘） */
export function generateToken(): string {
    return randomBytes(32).toString('base64url');
}

/** 32 字节随机 id（requestId / membershipId；不可猜，所以可作 bearer 凭据用） */
export function newId(prefix: string): string {
    return `${prefix}_${randomBytes(16).toString('base64url')}`;
}
