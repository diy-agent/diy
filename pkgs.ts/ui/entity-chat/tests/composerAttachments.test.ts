// tests/composerAttachments.test.ts —— 拖目录进来时那两条判断（纯函数，不碰 DOM）
//
// 锁两件事：
//   ① 拖目录 = 浏览器逐个给文件，`webkitRelativePath` 才带层级 ⇒ 显示名用它，
//      否则 `login/a.png` 与 `home/a.png` 在气泡里会变成两个都叫 `a.png` 的方块
//   ② 超上限的提示要带「这次一共来了几个」—— 拖目录时人只看到「没传完」，不给总数，
//      他不知道自己漏了 1 个还是 100 个

import { describe, expect, it } from 'vitest';

import { displayNameOf, limitMessage } from '../src/components/useComposerAttachments';

describe('displayNameOf', () => {
    it('拖目录进来：用相对路径（带层级）', () => {
        expect(displayNameOf({ name: 'a.png', webkitRelativePath: 'design/login/a.png' })).toBe('design/login/a.png');
    });

    it('普通文件 / 剪贴板：退回文件名（相对路径是空串，不是 undefined）', () => {
        expect(displayNameOf({ name: 'shot.png', webkitRelativePath: '' })).toBe('shot.png');
        expect(displayNameOf({ name: 'shot.png' })).toBe('shot.png');
        expect(displayNameOf({ name: '' })).toBe('');
    });
});

describe('limitMessage', () => {
    it('超上限：说清总数，并给出「分两次」的出路', () => {
        expect(limitMessage(30, 8)).toBe('这次有 30 个文件，一次最多发 8 个（先发这些，剩下的再拖一次）');
    });

    it('只是加满了（这次没超）：只报上限，不提总数', () => {
        expect(limitMessage(3, 8)).toBe('一次最多 8 个附件');
    });
});
