// diy-app 的版本号（**唯一源**）。
//
// 为什么不用 `app.getVersion()`：非打包运行时它返回的是 **Electron 的版本**（实测 `/ping` 里
// 出现过 "43.1.1"），而 `/ping` 的 version 是要给对面的机器判断「对面是不是同代 diy」用的 ——
// 报 Electron 版本等于没报。改版本 = 改这里 + `pkgs.ts/diy-app/package.json`（两处，发布脚本读后者）。
export const APP_VERSION = "0.1.0";
