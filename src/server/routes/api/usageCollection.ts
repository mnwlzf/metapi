import type { FastifyInstance } from 'fastify';
import { getUsageCollectionConfig } from '../../services/usageCollectionStore.js';
import { getUsageOverview, queueUsageSync, updateUsageCollectionConfig } from '../../services/usageCollectionService.js';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';

export async function usageCollectionRoutes(app: FastifyInstance) {
  const mutationGuard = createRateLimitGuard({ bucket: 'usage-collection-mutations', max: 12, windowMs: 60_000 });
  app.get('/api/consumption', async () => getUsageOverview());
  app.get('/api/consumption/settings', async () => getUsageCollectionConfig());
  app.put('/api/consumption/settings', { preHandler: [mutationGuard] }, async (request, reply) => {
    try { return await updateUsageCollectionConfig(request.body); }
    catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : '设置无效' }); }
  });
  app.post('/api/consumption/sync', { preHandler: [mutationGuard] }, async (request, reply) => {
    if (request.body !== undefined && request.body !== null && (typeof request.body !== 'object' || Array.isArray(request.body))) return reply.code(400).send({ message: '同步参数格式无效' });
    const body = (request.body || {}) as Record<string, unknown>;
    if (body.siteId !== undefined && (!Number.isSafeInteger(body.siteId) || Number(body.siteId) <= 0)) return reply.code(400).send({ message: '站点 ID 无效' });
    if ((body.start !== undefined && typeof body.start !== 'string') || (body.end !== undefined && typeof body.end !== 'string') || (body.resume !== undefined && typeof body.resume !== 'boolean')) return reply.code(400).send({ message: '日期与恢复参数格式无效' });
    try {
      return await queueUsageSync({
        siteId: body.siteId as number | undefined,
        start: typeof body.start === 'string' ? body.start : undefined,
        end: typeof body.end === 'string' ? body.end : undefined,
        resume: body.resume === true,
      });
    } catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : '同步参数无效' }); }
  });
}
