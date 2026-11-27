// tests/ref.test.ts — ref 的形状校验（外部输入的第一道闸）
//
// 为什么要单独测：ref 从**消息 json / sqlite / RPC 回包**读回来，全是外部输入。
// 一个拼错的键、一个 `../` 的 relPath，后果分别是「图悄悄不显示」与「读到 blobs 外的文件」。

import { describe, expect, it } from 'vitest';

import { AttachmentError, parseAttachmentRef, parseAttachmentRefs, type AttachmentRef } from '../src/index.js';

const stored: AttachmentRef = {
    type: 'stored',
    id: '2026-11-26/093012-abcd1234/01-shot.png',
    relPath: '2026-11-26/093012-abcd1234/01-shot.png',
    kind: 'image',
    mime: 'image/png',
    bytes: 128,
    displayName: 'shot.png',
    source: 'paste',
    createdAt: 1_764_120_000_000,
    sha256: 'a'.repeat(64),
    image: { width: 1440, height: 900 },
};

const linked: AttachmentRef = {
    type: 'linked',
    id: 'ref-0123456789ab',
    path: '/Users/me/report.pdf',
    kind: 'file',
    mime: 'application/pdf',
    bytes: 4096,
    displayName: 'report.pdf',
    source: 'path',
    createdAt: 1_764_120_000_000,
};

describe('parseAttachmentRef', () => {
    it('stored / linked 都能原样往返（过一遍 JSON 也不变形）', () => {
        expect(parseAttachmentRef(stored)).toEqual(stored);
        expect(parseAttachmentRef(linked)).toEqual(linked);
        expect(parseAttachmentRef(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    });

    it('目录概览也验（archive / dir 靠它才有内容可说）', () => {
        const withListing = {
            ...linked,
            kind: 'dir',
            mime: 'inode/directory',
            listing: { count: 3, sample: ['a.png', 'sub/b.png'], truncated: true },
        };
        expect(parseAttachmentRef(withListing).listing).toEqual({
            count: 3,
            sample: ['a.png', 'sub/b.png'],
            truncated: true,
        });
    });

    it('未知键一律报错（拼错 `relpath` 必须是显式失败）', () => {
        const broken: Record<string, unknown> = { ...stored };
        broken.relpath = broken.relPath;
        delete broken.relPath;
        expect(() => parseAttachmentRef(broken)).toThrow(AttachmentError);
    });

    it('缺字段 / 未知类别 / 未知来源 / 坏 sha256 都报错', () => {
        const { kind: _kind, ...noKind } = stored as unknown as Record<string, unknown>;
        expect(() => parseAttachmentRef(noKind)).toThrow(/kind/);

        expect(() => parseAttachmentRef({ ...stored, kind: 'video' })).toThrow(/未知类别/);
        expect(() => parseAttachmentRef({ ...stored, source: 'clipboard' })).toThrow(/未知来源/);
        expect(() => parseAttachmentRef({ ...stored, sha256: 'XYZ' })).toThrow(/sha256/);
        expect(() => parseAttachmentRef({ ...stored, bytes: -1 })).toThrow(/非负整数/);
    });

    it('relPath 逃逸 / 绝对路径拒收；path 必须绝对', () => {
        expect(() => parseAttachmentRef({ ...stored, relPath: '../../../etc/passwd' })).toThrow(/相对路径/);
        expect(() => parseAttachmentRef({ ...stored, relPath: '/etc/passwd' })).toThrow(/相对路径/);
        expect(() => parseAttachmentRef({ ...linked, path: 'report.pdf' })).toThrow(/绝对路径/);
    });

    it('目录不可能是 stored（要么引用，要么打包）', () => {
        expect(() => parseAttachmentRef({ ...stored, kind: 'dir' })).toThrow(/目录不可能 stored/);
    });

    it('形态与位置字段必须配套（stored 不许带 path）', () => {
        expect(() => parseAttachmentRef({ ...stored, path: '/tmp/x' })).toThrow(/未知字段/);
    });

    it('一批 ref：数组才收，逐项报错带下标', () => {
        expect(parseAttachmentRefs([stored, linked])).toHaveLength(2);
        expect(() => parseAttachmentRefs({})).toThrow(/数组/);
        expect(() => parseAttachmentRefs([stored, { ...linked, kind: 'nope' }])).toThrow(/\[1\]/);
    });
});
