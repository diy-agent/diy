// 08 — 实现。**只有服务端 / 本地 import 这个文件**。
//
// 参数类型、返回类型都从 roomApi 推出来，这里一个类型标注都没有。
// 状态（seq / lines）放 setup 里，handler 通过 ctx.state 访问。
// 这里可以自由 import fs —— 客户端的 import 图里没有这个文件。
import { implement } from '../../src/cmd.js';
import { roomApi } from './api.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let inits = 0;

export const makeRoom = implement(
    roomApi,
    // setup：一次 actor 生命周期跑一次。闭包初始化有副作用也不要紧 —— 客户端不会执行它
    () => {
        inits++;
        return { seq: 0, lines: [] as string[] };
    },
    {
        say: ({ who, text }, { state }) => {
            state.seq++;
            state.lines.push(`${state.seq}. ${who}: ${text}`);
            return state.seq;
        },

        lines: (_input, { state }) => state.lines.map((text, i) => ({ seq: i + 1, text })),

        slow: async ({ ms }, { signal }) => {
            for (let i = 1; i <= ms / 10; i++) {
                if (signal.aborted) return `第 ${i} 次检查时停下`;
                await sleep(10);
            }
            return '跑完了';
        },

        boom: ({ msg }) => {
            throw new Error(msg);
        },
    },
);

export const initCount = () => inits;
