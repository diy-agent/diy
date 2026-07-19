// src/main/services/llm-proxy.ts
// 🎯 LLM 代理服务器 — 内嵌 Fastify，透明代理到上游 API

import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

/** LLM 代理服务器 */
export class LlmProxy {
  private server: FastifyInstance | null = null;
  private port: number;

  constructor(port = 8000) {
    this.port = port;
  }

  /** 启动代理 */
  start(): void {
    this.server = Fastify({ logger: false });

    this.server.all("/*", async (request: FastifyRequest, reply: FastifyReply) => {
      const upstream = request.url;
      const method = request.method;

      // 仅转发关键的 header
      const headers: Record<string, string> = {};
      const ct = request.headers["content-type"];
      if (typeof ct === "string") headers["content-type"] = ct;
      const auth = request.headers["authorization"];
      if (typeof auth === "string") headers["authorization"] = auth;

      try {
        const resp = await fetch(upstream, {
          method,
          headers,
          body: method !== "GET" && method !== "HEAD" ? JSON.stringify(request.body) : undefined,
        });
        reply.status(resp.status);
        resp.headers.forEach((value: string, key: string) => {
          reply.header(key, value);
        });
        reply.send(await resp.text());
      } catch (e) {
        reply.status(502).send({ error: "上游不可达", detail: String(e) });
      }
    });

    this.server.listen({ port: this.port, host: "127.0.0.1" });
  }

  /** 停止代理 */
  stop(): void {
    this.server?.close();
    this.server = null;
  }

  get isRunning(): boolean {
    return this.server !== null;
  }
}
