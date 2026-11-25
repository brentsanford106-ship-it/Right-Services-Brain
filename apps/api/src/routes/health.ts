import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./index.js";

export async function healthRoutes(app: FastifyInstance, { db }: RouteDeps): Promise<void> {
  app.get("/health/live", { config: { rateLimit: false } }, async () => ({ status: "ok" }));
  app.get("/health/ready", { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      await db.anonymous((tx) => tx.query("SELECT 1"));
      return { status: "ok" };
    } catch {
      return reply.status(503).send({ status: "unavailable" });
    }
  });
}
