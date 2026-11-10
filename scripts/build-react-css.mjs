#!/usr/bin/env node
// build-react-css.mjs —— 把 chat-page 的 react.css（tailwind 工具类 + M3 令牌桥）编成一份产物。
//
// 为什么要一个脚本：三个宿主（apps/chat · apps/minimal · apps/web）都要这份 CSS，
// 但各自的构建入口不同（sha.sh / main.mjs）。给一份单一实现，别让 @tailwindcss/cli
// 的命令行参数在三个地方各写一遍、慢慢长歪。
//
// 用法：node scripts/build-react-css.mjs <输出文件>
//   例：node scripts/build-react-css.mjs apps/chat/build/app/renderer/renderer.css
//
// 输入固定为 pkgs.ts/ui/chat-page/src/react.css（@source 由它在内部声明）；
// 输出位置由调用方给（跟各宿主的 renderer 产物放一起）。

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2];
if (!out) {
    console.error('用法：node scripts/build-react-css.mjs <输出文件>');
    process.exit(2);
}
const cli = resolve(repo, 'node_modules/@tailwindcss/cli/dist/index.mjs');
const input = resolve(repo, 'pkgs.ts/ui/chat-page/src/react.css');
// 输出按**调用方 cwd** 解析（各宿主的 sha.sh 里写的是自己目录下的相对路径）
const target = resolve(process.cwd(), out);

mkdirSync(dirname(target), { recursive: true });
execFileSync(process.execPath, [cli, '-i', input, '-o', target, '--minify'], { stdio: 'inherit', cwd: repo });
console.log(`[react-css] → ${target}`);
