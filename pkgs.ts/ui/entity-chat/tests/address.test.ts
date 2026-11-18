// 地址的序列化 / 解析：`/room/task/t-001` 这一层是「现在在看哪儿」的唯一真相。
//
// 锁的是四件事：
//   1. 往返不丢（含带 `:` 的 id、带 `/` 的 id、中文）；
//   2. `kind:local` 展开成两段（`/room/task/t-001`），没有冒号的 id 仍是一段；
//   3. 认不得的输入**静默**返回 undefined（首屏 `/`、另一个 HTML 入口 `/perf.html`、手滑的书签）；
//   4. 不在 encode 侧产出 `%3A` 之外的怪东西，也不产出尾斜杠 / 空段。

import { describe, expect, it } from 'vitest';

import {
    addressOf,
    DEFAULT_PAGE,
    formatAddress,
    isCanonicalPath,
    knownPage,
    parseAddress,
    pickAddress,
    registerPage,
    roomAddressOf,
    sameAddress,
    type NavAddress,
} from '../src/address';

describe('formatAddress / parseAddress —— 往返', () => {
    it('kind:local 拆成两段（冒号不进地址栏）', () => {
        expect(formatAddress(addressOf('room', 'task:t-001'))).toBe('/room/task/t-001');
        expect(parseAddress('/room/task/t-001')).toEqual({ page: 'room', id: 'task:t-001' });
        expect(formatAddress(addressOf('room', 'proj:diy'))).toBe('/room/proj/diy');
        expect(parseAddress('/room/proj/diy')).toEqual({ page: 'room', id: 'proj:diy' });
    });

    it('没有冒号的 id（运行时新建）保持一段', () => {
        expect(formatAddress(addressOf('room', 'task-mf3k2ab'))).toBe('/room/task-mf3k2ab');
        expect(parseAddress('/room/task-mf3k2ab')).toEqual({ page: 'room', id: 'task-mf3k2ab' });
    });

    it('老地址（冒号没展开）仍然解析得回来 —— 已贴出去的链接不烂', () => {
        expect(parseAddress('/room/task:t-001')).toEqual({ page: 'room', id: 'task:t-001' });
        expect(parseAddress('/room/proj:diy')).toEqual({ page: 'room', id: 'proj:diy' });
    });

    it('local 里的斜杠被转义，回来还是同一个 id（task:projects/1/tasks/1）', () => {
        const path = formatAddress(addressOf('room', 'task:projects/1/tasks/1'));
        expect(path).toBe('/room/task/projects%2F1%2Ftasks%2F1');
        expect(parseAddress(path)).toEqual({ page: 'room', id: 'task:projects/1/tasks/1' });
    });

    it('没有 kind 前缀、纯路径的 id 也往返（只是地址不好看）', () => {
        const path = formatAddress(addressOf('room', 'projects/1/tasks/1'));
        expect(path).toBe('/room/projects%2F1%2Ftasks%2F1');
        expect(parseAddress(path)).toEqual({ page: 'room', id: 'projects/1/tasks/1' });
    });

    it('只换第一个冒号（`a:b:c` → 两段，local 里的冒号保留）', () => {
        const path = formatAddress(addressOf('room', 'a:b:c'));
        expect(path).toBe('/room/a/b:c');
        expect(parseAddress(path)).toEqual({ page: 'room', id: 'a:b:c' });
    });

    it('中文 id 往返一致（地址栏显示原文，pathname 拿回编码后的）', () => {
        const path = formatAddress(addressOf('room', '任务-一'));
        expect(parseAddress(path)).toEqual({ page: 'room', id: '任务-一' });
        expect(parseAddress(encodeURI(path))).toEqual({ page: 'room', id: '任务-一' });
    });

    it('别的页也走同一条路（page 不是枚举）', () => {
        expect(parseAddress('/task-run/task/t-001')).toEqual({ page: 'task-run', id: 'task:t-001' });
        expect(parseAddress('/film/film-run/r-3')).toEqual({ page: 'film', id: 'film-run:r-3' });
    });

    it('# 和 ? 在 id 里被转义，不会被当成片段 / 查询', () => {
        const path = formatAddress(addressOf('room', 'a#b?c'));
        expect(path).toBe('/room/a%23b%3Fc');
        expect(parseAddress(path)).toEqual({ page: 'room', id: 'a#b?c' });
    });

    it('退化 id（开头 / 结尾是冒号）：不拆段、不产出空段，照样往返', () => {
        expect(formatAddress(addressOf('room', 'task:'))).toBe('/room/task:');
        expect(parseAddress('/room/task:')).toEqual({ page: 'room', id: 'task:' });
        expect(formatAddress(addressOf('room', ':t-001'))).toBe('/room/:t-001');
        expect(parseAddress('/room/:t-001')).toEqual({ page: 'room', id: ':t-001' });
    });
});

describe('parseAddress —— 认不得就返回 undefined，不抛', () => {
    it('首屏 / 与空串', () => {
        expect(parseAddress('/')).toBeUndefined();
        expect(parseAddress('')).toBeUndefined();
    });

    it('只有 page 没有 id', () => {
        expect(parseAddress('/room')).toBeUndefined();
        expect(parseAddress('/room/')).toBeUndefined();
    });

    it('另一个 HTML 入口（多入口页面不该被当成地址）', () => {
        expect(parseAddress('/perf.html')).toBeUndefined();
        expect(parseAddress('/stops.html')).toBeUndefined();
    });

    it('查询串 / 片段不算位置', () => {
        expect(parseAddress('/room/task/t-001?debug=1')).toEqual({ page: 'room', id: 'task:t-001' });
        expect(parseAddress('/room/task/t-001#top')).toEqual({ page: 'room', id: 'task:t-001' });
    });

    it('坏编码按原样收下（地址栏是用户能改的输入）', () => {
        expect(parseAddress('/room/%zz')).toEqual({ page: 'room', id: '%zz' });
    });
});

describe('sameAddress —— 防重复导航', () => {
    it('同 page 同 id 才算同一个位置', () => {
        expect(sameAddress(addressOf('room', 'a'), addressOf('room', 'a'))).toBe(true);
        expect(sameAddress(addressOf('room', 'a'), addressOf('task-run', 'a'))).toBe(false);
        expect(sameAddress(addressOf('room', 'a'), addressOf('room', 'b'))).toBe(false);
    });

    it('undefined 只和 undefined 相等', () => {
        expect(sameAddress(undefined, undefined)).toBe(true);
        expect(sameAddress(undefined, addressOf('room', 'a'))).toBe(false);
    });
});

describe('roomAddressOf', () => {
    it('room id 直接当 id，不重复记 kind', () => {
        expect(roomAddressOf({ id: 'proj:diy' })).toEqual({ page: 'room', id: 'proj:diy' });
        expect(formatAddress(roomAddressOf({ id: 'proj:diy' }))).toBe('/room/proj/diy');
    });
});

describe('isCanonicalPath —— 一个位置只能有一个地址', () => {
    it('规范写法不重写；老写法（冒号没展开）要被收编', () => {
        const target = addressOf('room', 'task:t-001');
        expect(isCanonicalPath('/room/task/t-001', target)).toBe(true);
        // 老地址指向同一处，但写法不是规范形态 —— 出口必须纠正，否则两种写法永久并存
        expect(isCanonicalPath('/room/task:t-001', target)).toBe(false);
    });

    it('浏览器把中文编成 %XX 不算「写法变了」，否则每次刷新都多一次 replaceState', () => {
        const target = addressOf('room', 'task:中文');
        const canonical = formatAddress(target);
        expect(isCanonicalPath(canonical, target)).toBe(true);
        expect(isCanonicalPath(encodeURI(canonical), target)).toBe(true);
        expect(isCanonicalPath('/room/task/别的', target)).toBe(false);
    });
});

describe('点段 —— 浏览器会吃掉 `.` / `..`（连 `%2E` 也吃），必须换前缀', () => {
    it('`.` / `..` 段加 `~` 前缀，parse 回来还是原来的 id', () => {
        const dotted = formatAddress(addressOf('room', '.:x'));
        expect(dotted).toBe('/room/~./x');
        expect(parseAddress(dotted)).toEqual({ page: 'room', id: '.:x' });
        expect(formatAddress(addressOf('room', '..'))).toBe('/room/~..');
        expect(parseAddress('/room/~..')).toEqual({ page: 'room', id: '..' });
    });

    it('`%2E` 不能用在地址里 —— WHATWG 把 `%2E` 单段当「本层」忽略（这条是回归锁）', () => {
        // 不是为了验证我们支持 %2E，而是记住为什么放弃它：浏览器会把这一段吃掉
        expect(formatAddress(addressOf('room', '.:x'))).not.toContain('%2E');
    });

    it('只转义整段是点的情况（`.hidden` 不是特殊段）', () => {
        expect(formatAddress(addressOf('room', 'task:.hidden'))).toBe('/room/task/.hidden');
        // 真以 `~.` 开头的 id：`~` 先被编成 %7E，不会被误认成点转义
        expect(parseAddress(formatAddress(addressOf('room', '~.x')))).toEqual({ page: 'room', id: '~.x' });
        expect(formatAddress(addressOf('room', '~'))).toBe('/room/%7E');
        expect(parseAddress('/room/%7E')).toEqual({ page: 'room', id: '~' });
    });
});

describe('knownPage —— 未注册的页就是坏地址', () => {
    it('只有 room 已注册；注册后认得', () => {
        expect(knownPage('room')).toBe(true);
        expect(knownPage('foo')).toBe(false);
        expect(knownPage('')).toBe(false);
        registerPage('task-run');
        expect(knownPage('task-run')).toBe(true);
    });
});

describe('pickAddress —— 刷新后落哪儿（三步优先级）', () => {
    const rooms = [{ id: 'proj:diy' }, { id: 'task:t-001' }];
    const known = (candidate: NavAddress): boolean => rooms.some((room) => room.id === candidate.id);
    const fallback = roomAddressOf(rooms[0]!);

    it('1. 内存里合法 → 保持（改名 / 改状态触发的 refresh 不该动位置）', () => {
        expect(
            pickAddress({
                current: addressOf('room', 'task:t-001'),
                fromUrl: addressOf('room', 'proj:diy'),
                known,
                fallback,
            }),
        ).toEqual(addressOf('room', 'task:t-001'));
    });

    it('2. 内存空（首屏）→ 用地址栏里的', () => {
        expect(
            pickAddress({ current: addressOf('room', ''), fromUrl: addressOf('room', 'task:t-001'), known, fallback }),
        ).toEqual(addressOf('room', 'task:t-001'));
    });

    it('2b. 地址栏里的房间已经没了 → 落到 fallback', () => {
        expect(
            pickAddress({
                current: addressOf('room', ''),
                fromUrl: addressOf('room', 'task:deleted'),
                known,
                fallback,
            }),
        ).toEqual(fallback);
    });

    it('3. 两边都没有 → fallback；一个房间都没有时 fallback 是空地址', () => {
        expect(pickAddress({ current: addressOf('room', ''), known, fallback })).toEqual(fallback);
        const empty = addressOf(DEFAULT_PAGE, '');
        expect(pickAddress({ current: empty, known, fallback: empty })).toEqual(empty);
    });
});
