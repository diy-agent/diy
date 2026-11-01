// virtual-authenticator.ts — 测试用的**虚拟 authenticator**：自己造合法的 WebAuthn 响应。
//
// @simplewebauthn/server 只吃「浏览器交回来的响应」，不提供虚拟设备；这里用真 ECDSA P-256
// 造一份（attestation fmt = none，flags = UP|UV），够本刀验签用：
//   · 注册：authData = rpIdHash | flags(0x45) | counter(0) | AAGUID | credId | COSE 公钥
//           attestationObject = CBOR { fmt:'none', attStmt:{}, authData }
//   · 断言：authData = rpIdHash | flags(0x05) | counter(++), 签 authData ‖ sha256(clientDataJSON)
//   · counter 每次断言 +1 —— 「服务端有没有更新 counter」的判据就靠它（防克隆检测）
//
// 签名用 node:crypto 的 `createSign('SHA256')`：它输出 **ASN.1 DER**，正是 WebAuthn 的口径
// （simplewebauthn 的 unwrapEC2Signature 会先把 DER 拆成 r‖s 再交给 WebCrypto）。

import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';
import type {
    AuthenticationResponseJSON,
    PublicKeyCredentialCreationOptionsJSON,
    PublicKeyCredentialRequestOptionsJSON,
    RegistrationResponseJSON,
} from '@simplewebauthn/server';

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export interface VirtualAuthenticator {
    /** base64url credential ID */
    readonly id: string;
    /** 这台设备当前的签名计数（每次断言 +1） */
    readonly counter: () => number;
    register(input: {
        readonly options: PublicKeyCredentialCreationOptionsJSON;
        readonly origin: string;
        readonly rpID: string;
    }): RegistrationResponseJSON;
    authenticate(input: {
        readonly options: PublicKeyCredentialRequestOptionsJSON;
        readonly origin: string;
        readonly rpID: string;
    }): AuthenticationResponseJSON;
}

function sha256(bytes: Uint8Array): Uint8Array {
    return new Uint8Array(createHash('sha256').update(Buffer.from(bytes)).digest());
}

/** CBOR 编码（tiny-cbor 的类型要求精确的 CBORType，测试里用不着那个精度，收窄成一次断言） */
function cbor(value: ReadonlyMap<string | number, unknown>): Uint8Array {
    return isoCBOR.encode(value as unknown as Parameters<typeof isoCBOR.encode>[0]);
}

function utf8(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, 'utf-8'));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
    return new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part))));
}

function uint32(value: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, false);
    return out;
}

function uint16(value: number): Uint8Array {
    const out = new Uint8Array(2);
    new DataView(out.buffer).setUint16(0, value, false);
    return out;
}

/** base64url（= WebAuthn 的编码口径：无 padding） */
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/** 造一台设备。`userHandle` 由注册响应里的 user.id 决定，断言时原样回带（发现式凭证的规矩）。 */
export function createVirtualAuthenticator(): VirtualAuthenticator {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const x = isoBase64URL.toBuffer(jwk.x);
    const y = isoBase64URL.toBuffer(jwk.y);
    const credentialId = isoBase64URL.fromBuffer(new Uint8Array(randomBytes(16)));
    // COSE_Key（ES256 / P-256）：1=kty(EC2=2) 3=alg(-7) -1=crv(P-256=1) -2=x -3=y
    const coseKey = cbor(
        new Map<number, unknown>([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, x],
            [-3, y],
        ]),
    );
    let counter = 0;
    let userHandle = new Uint8Array(0);

    const clientData = (type: string, challenge: string, origin: string): Uint8Array =>
        utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

    return {
        id: credentialId,
        counter: () => counter,

        register({ options, origin, rpID }) {
            userHandle = isoBase64URL.toBuffer(options.user.id);
            const clientDataJSON = clientData('webauthn.create', options.challenge, origin);
            const authData = concat([
                sha256(utf8(rpID)),
                new Uint8Array([FLAG_UP | FLAG_UV | FLAG_AT]),
                uint32(0),
                new Uint8Array(16), // AAGUID（全是 0 = 没有归属）
                uint16(isoBase64URL.toBuffer(credentialId).length),
                isoBase64URL.toBuffer(credentialId),
                coseKey,
            ]);
            const attestationObject = cbor(
                new Map<string, unknown>([
                    ['fmt', 'none'],
                    ['attStmt', new Map<string, unknown>()],
                    ['authData', authData],
                ]),
            );
            return {
                id: credentialId,
                rawId: credentialId,
                type: 'public-key',
                clientExtensionResults: {},
                authenticatorAttachment: 'platform',
                response: {
                    clientDataJSON: b64(clientDataJSON),
                    attestationObject: b64(attestationObject),
                    transports: ['internal'],
                },
            };
        },

        authenticate({ options, origin, rpID }) {
            counter += 1;
            const clientDataJSON = clientData('webauthn.get', options.challenge, origin);
            const authData = concat([sha256(utf8(rpID)), new Uint8Array([FLAG_UP | FLAG_UV]), uint32(counter)]);
            const signature = new Uint8Array(
                createSign('SHA256')
                    .update(Buffer.from(concat([authData, sha256(clientDataJSON)])))
                    .sign(privateKey),
            );
            return {
                id: credentialId,
                rawId: credentialId,
                type: 'public-key',
                clientExtensionResults: {},
                authenticatorAttachment: 'platform',
                response: {
                    clientDataJSON: b64(clientDataJSON),
                    authenticatorData: b64(authData),
                    signature: b64(signature),
                    userHandle: b64(userHandle),
                },
            };
        },
    };
}
