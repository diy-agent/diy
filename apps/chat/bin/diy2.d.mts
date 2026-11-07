// diy-chat.mjs 的类型声明（入口是运行态薄脚本，不参与 tsc 编译；测试只用到这两个）。
export interface DiyChatArgs {
    kind: "help" | "version" | "electron" | "launch";
    check: boolean;
    mirror?: string;
    zip?: string;
    passthrough: string[];
}

export declare function parseArgs(argv: string[]): DiyChatArgs;
export declare function main(argv?: string[]): Promise<number>;
