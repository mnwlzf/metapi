import { FastifyInstance } from 'fastify';
import { db, schema, runtimeDbDialect } from '../../db/index.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { rebuildRoutesBestEffort } from '../../services/accountMutationWorkflow.js';
import { AccountModelScopeError, getAccountModelList, replaceAccountManualDisabledModels, setAccountModelDisabled } from '../../services/accountModelManagementService.js';
import { parseAccountManualModelsPayload } from '../../contracts/accountsRoutePayloads.js';

/**
 * Per-account model list and per-key disabled/manual overrides.
 *
 * Extracted from accounts.ts; registered by calling this function directly
 * from accountsRoutes so the Fastify encapsulation context (and every auth
 * hook) stays identical to the parent module.
 */
export function registerAccountModelRoutes(app: FastifyInstance) {
  const scopeSchema = z.object({
    accountId: z.coerce.number().int().positive(),
    tokenId: z.coerce.number().int().nonnegative().default(0),
  });
  const replaceSchema = z.object({
    models: z.array(z.string()),
    newModelPolicy: z.enum(['auto', 'disable']).optional(),
  });
  const toggleSchema = z.object({ modelName: z.string().trim().min(1), disabled: z.boolean() });
  const sendScopeError = (error: unknown, reply: import('fastify').FastifyReply) => {
    if (error instanceof AccountModelScopeError) return reply.code(error.statusCode).send({ message: error.message });
    throw error;
  };

  app.get<{ Params: { id: string }; Querystring: { tokenId?: string } }>(
    '/api/accounts/:id/models', async (request, reply) => {
      const scope = scopeSchema.safeParse({ accountId: request.params.id, tokenId: request.query.tokenId });
      if (!scope.success) return reply.code(400).send({ message: 'Invalid account or key ID' });
      try { return await getAccountModelList(scope.data.accountId, scope.data.tokenId); }
      catch (error) { return sendScopeError(error, reply); }
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/accounts/:id/models/disabled', async (request, reply) => {
      const body = replaceSchema.safeParse(request.body);
      const scope = scopeSchema.safeParse({ accountId: request.params.id,
        tokenId: (request.body as { tokenId?: unknown } | null)?.tokenId });
      if (!body.success || !scope.success) return reply.code(400).send({ message: 'Invalid model disable settings' });
      try { return await replaceAccountManualDisabledModels({ ...scope.data, ...body.data }); }
      catch (error) { return sendScopeError(error, reply); }
    },
  );

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/accounts/:id/models/disabled', async (request, reply) => {
      const body = toggleSchema.safeParse(request.body);
      const scope = scopeSchema.safeParse({ accountId: request.params.id,
        tokenId: (request.body as { tokenId?: unknown } | null)?.tokenId });
      if (!body.success || !scope.success) return reply.code(400).send({ message: 'Invalid model disable settings' });
      try { return await setAccountModelDisabled({ ...scope.data, ...body.data }); }
      catch (error) { return sendScopeError(error, reply); }
    },
  );

  // Remove manually added models from an account
  app.delete<{ Params: { id: string }; Body: unknown }>(
    '/api/accounts/:id/models/manual',
    async (request, reply) => {
      const parsedBody = parseAccountManualModelsPayload(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({ message: parsedBody.error });
      }

      const accountId = parseInt(request.params.id, 10);
      if (!Number.isFinite(accountId) || accountId <= 0) {
        return reply.code(400).send({ message: '账号 ID 无效' });
      }

      const { models } = parsedBody.data;
      if (!Array.isArray(models) || models.length === 0) {
        return reply.code(400).send({ message: '模型列表不能为空' });
      }

      const normalizedModels = Array.from(
        new Set(
          models.map((m) => String(m).trim()).filter((m) => m.length > 0),
        ),
      );
      if (normalizedModels.length === 0) {
        return reply.code(400).send({ message: '模型列表不能为空' });
      }

      const account = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .get();

      if (!account) {
        return reply.code(404).send({ message: '账号不存在' });
      }

      try {
        await db.transaction(async (tx: any) => {
          for (const modelName of normalizedModels) {
            await tx
              .delete(schema.modelAvailability)
              .where(
                and(
                  eq(schema.modelAvailability.accountId, accountId),
                  eq(schema.modelAvailability.modelName, modelName),
                  eq(schema.modelAvailability.isManual, true),
                ),
              )
              .run();
          }
        });
        await rebuildRoutesBestEffort();

        return { success: true };
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        return reply
          .code(500)
          .send({ success: false, message: errMessage || '删除失败' });
      }
    },
  );

  // Add models manually to an account
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/accounts/:id/models/manual',
    async (request, reply) => {
      const parsedBody = parseAccountManualModelsPayload(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({ message: parsedBody.error });
      }

      const accountId = parseInt(request.params.id, 10);
      if (!Number.isFinite(accountId) || accountId <= 0) {
        return reply.code(400).send({ message: '账号 ID 无效' });
      }

      const { models } = parsedBody.data;
      if (!Array.isArray(models) || models.length === 0) {
        return reply.code(400).send({ message: '模型列表不能为空' });
      }

      const normalizedModels = Array.from(
        new Set(
          models.map((m) => String(m).trim()).filter((m) => m.length > 0),
        ),
      );
      if (normalizedModels.length === 0) {
        return reply.code(400).send({ message: '模型列表不能为空' });
      }

      const account = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .get();

      if (!account) {
        return reply.code(404).send({ message: '账号不存在' });
      }

      try {
        await db.transaction(async (tx: any) => {
          const checkedAt = new Date().toISOString();
          for (const modelName of normalizedModels) {
            if (runtimeDbDialect === 'mysql') {
              const existing = await tx
                .select()
                .from(schema.modelAvailability)
                .where(
                  and(
                    eq(schema.modelAvailability.accountId, accountId),
                    eq(schema.modelAvailability.modelName, modelName),
                  ),
                )
                .get();

              if (existing) {
                await tx
                  .update(schema.modelAvailability)
                  .set({
                    available: true,
                    latencyMs: null,
                    isManual: true,
                    checkedAt,
                  })
                  .where(eq(schema.modelAvailability.id, existing.id))
                  .run();
              } else {
                await tx
                  .insert(schema.modelAvailability)
                  .values({
                    accountId,
                    modelName,
                    available: true,
                    isManual: true,
                    latencyMs: null,
                    checkedAt,
                  })
                  .run();
              }
            } else {
              // SQLite / PostgreSQL path
              await (
                tx.insert(schema.modelAvailability).values({
                  accountId,
                  modelName,
                  available: true,
                  isManual: true,
                  latencyMs: null,
                  checkedAt,
                }) as any
              )
                .onConflictDoUpdate({
                  target: [
                    schema.modelAvailability.accountId,
                    schema.modelAvailability.modelName,
                  ],
                  set: {
                    available: true,
                    isManual: true,
                    latencyMs: null,
                    checkedAt,
                  },
                })
                .run();
            }
          }
        });
        await rebuildRoutesBestEffort();

        return { success: true };
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        return reply
          .code(500)
          .send({ success: false, message: errMessage || '保存失败' });
      }
    },
  );
}
