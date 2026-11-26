import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// No upstream traffic: the endpoints only read local tables.
vi.mock('dotenv/config', () => ({}));
vi.mock('undici', async (importOriginal) => ({
  ...await importOriginal<typeof import('undici')>(),
  fetch: vi.fn().mockRejectedValue(new Error('Unexpected network request in probe-runs test')),
}));

type DbModule = typeof import('../../db/index.js');

/**
 * One click on "probe all" writes hundreds of rows. The runs endpoint answers
 * "what did that attempt do, and what did it cost" in one row per batch, which is
 * what the batch view of the log page renders.
 */
describe('GET /api/probe-logs/runs', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-probe-runs-'));
    vi.stubEnv('DATA_DIR', dataDir);
    vi.stubEnv('DB_TYPE', 'sqlite');
    vi.stubEnv('DB_URL', join(dataDir, 'hub.db'));

    await import('../../db/migrate.js');
    ({ db, schema, closeDbConnections } = await import('../../db/index.js'));
    app = Fastify();
    await app.register((await import('./probeLogs.js')).registerProbeLogsRoutes);
  });

  afterAll(async () => {
    await app?.close();
    await closeDbConnections?.();
    vi.unstubAllEnvs();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('aggregates each run: counts, distinct keys/models and the spend', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'runs-site', url: 'https://runs.example.invalid', platform: 'new-api', status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id, username: 'runs-user', accessToken: 'tok', status: 'active',
    }).returning().get();
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id, name: 'key', token: 'sk-key', tokenGroup: '30', enabled: true,
    }).returning().get();

    await db.insert(schema.probeLogs).values([
      {
        siteId: site.id, accountId: account.id, tokenId: token.id, runId: 'run-a',
        modelName: 'gpt-4o', questionCategory: 'math', questionText: 'q',
        status: 'success', latencyMs: 100, tokensUsed: 50, estimatedCost: 0.001,
      },
      {
        siteId: site.id, accountId: account.id, tokenId: token.id, runId: 'run-a',
        modelName: 'gpt-4o-mini', questionCategory: 'math', questionText: 'q',
        status: 'failed', latencyMs: 80, estimatedCost: 0,
      },
      {
        siteId: site.id, accountId: account.id, tokenId: token.id, runId: 'run-a',
        modelName: 'gpt-4o-mini', questionCategory: 'logic', questionText: 'q',
        status: 'timeout', latencyMs: 30000,
      },
      // Rows without a run id (older data) must not form a fake batch.
      {
        siteId: site.id, accountId: account.id, modelName: 'gpt-4o',
        questionCategory: 'math', questionText: 'q', status: 'success',
      },
    ]).run();

    const response = await app.inject({ method: 'GET', url: '/api/probe-logs/runs' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      runs: Array<Record<string, unknown>>;
    };

    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      runId: 'run-a',
      siteId: site.id,
      siteName: 'runs-site',
      probed: 3,
      success: 1,
      failed: 1,
      timeout: 1,
      modelCount: 2,
      tokenCount: 1,
      accountCount: 1,
    });
    expect(Number(body.runs[0]!.totalCost)).toBeCloseTo(0.001, 6);
  });
});
