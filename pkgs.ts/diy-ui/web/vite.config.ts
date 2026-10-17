import { defineConfig, type Plugin } from "vite";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * 会话数据插件：把 `/sessions/<name>` 映射到本机的 `local/*.ops.jsonl`。
 *
 * 为什么走中间件而不是复制进 public/：真实大会话是 44~78MB 的二进制事实，
 * 不该进仓库、也不该为跑一次压测复制一份。默认读 mac 拷来的 DIY_HOME。
 */
const SESSIONS_DIR = resolve(process.env.DIY_SESSIONS_DIR ?? "D:/share/diy-home/local");

function sessionsPlugin(): Plugin {
  return {
    name: "diy-sessions",
    configureServer(server) {
      server.middlewares.use("/sessions", async (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
        const file = join(SESSIONS_DIR, normalize(rel));
        if (!file.startsWith(SESSIONS_DIR)) {
          res.statusCode = 403;
          res.end("forbidden");
          return;
        }
        try {
          const st = await stat(file);
          if (!st.isFile()) throw new Error("not a file");
          res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
          res.setHeader("content-length", String(st.size));
          createReadStream(file).pipe(res);
        } catch {
          next();
        }
      });
    },
  };
}

export default defineConfig({
  // JSX classic runtime：jsxFactory = h（见 src/providers/dom-jsx.ts）。
  // esbuild 会读取 tsconfig 的 jsxFactory，这里显式写一遍以免配置漂移。
  esbuild: {
    jsx: "transform",
    jsxFactory: "h",
    jsxFragment: "Fragment",
  },
  plugins: [sessionsPlugin()],
  build: {
    rollupOptions: {
      input: {
        index: resolve(ROOT, "index.html"),
        session: resolve(ROOT, "session.html"),
        chat: resolve(ROOT, "chat.html"),
        gen: resolve(ROOT, "gen.html"),
        unsafe: resolve(ROOT, "unsafe.html"),
      },
    },
  },
});
