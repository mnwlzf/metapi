import { FastifyInstance } from 'fastify';
import { db } from '../../db/index.js';
import { probeLogs, sites, accounts, accountTokens } from '../../db/schema.js';
import { eq, desc, and, gte, lte, sql } from 'drizzle-orm';
import { normalizePageOffset, normalizePageSize } from './paginationNormalizers.js';

const PROBE_LOG_SELECT = {
  id: probeLogs.id,
  siteId: probeLogs.siteId,
  accountId: probeLogs.accountId,
  tokenId: probeLogs.tokenId,
  runId: probeLogs.runId,
  modelName: probeLogs.modelName,
  questionCategory: probeLogs.questionCategory,
  questionText: probeLogs.questionText,
  responseText: probeLogs.responseText,
  status: probeLogs.status,
  latencyMs: probeLogs.latencyMs,
  tokensUsed: probeLogs.tokensUsed,
  estimatedCost: probeLogs.estimatedCost,
  errorMessage: probeLogs.errorMessage,
  createdAt: probeLogs.createdAt,
  siteName: sites.name,
  accountUsername: accounts.username,
  // A verdict belongs to one upstream key: without it the log cannot answer
  // "which key was probed", which is what made wrong verdicts unattributable.
  tokenName: accountTokens.name,
  tokenGroup: accountTokens.tokenGroup,
};

export async function registerProbeLogsRoutes(app: FastifyInstance) {
  // 获取测活日志列表
  app.get('/api/probe-logs', async (request, _reply) => {
    const {
      siteId,
      accountId,
      tokenId,
      runId,
      modelName,
      status,
      startTime,
      endTime,
      limit = 100,
      offset = 0,
    } = request.query as {
      siteId?: string;
      accountId?: string;
      tokenId?: string;
      runId?: string;
      modelName?: string;
      status?: string;
      startTime?: string;
      endTime?: string;
      limit?: string;
      offset?: string;
    };

    const conditions: any[] = [];

    if (siteId) {
      const parsedSiteId = parseInt(siteId, 10);
      if (Number.isFinite(parsedSiteId) && parsedSiteId > 0) {
        conditions.push(eq(probeLogs.siteId, parsedSiteId));
      }
    }

    if (accountId) {
      const parsedAccountId = parseInt(accountId, 10);
      if (Number.isFinite(parsedAccountId) && parsedAccountId > 0) {
        conditions.push(eq(probeLogs.accountId, parsedAccountId));
      }
    }

    if (tokenId) {
      const parsedTokenId = parseInt(tokenId, 10);
      if (Number.isFinite(parsedTokenId) && parsedTokenId > 0) {
        conditions.push(eq(probeLogs.tokenId, parsedTokenId));
      }
    }

    if (runId) {
      conditions.push(eq(probeLogs.runId, runId));
    }

    if (modelName) {
      conditions.push(eq(probeLogs.modelName, modelName));
    }

    if (status) {
      conditions.push(eq(probeLogs.status, status));
    }

    if (startTime) {
      conditions.push(gte(probeLogs.createdAt, startTime));
    }

    if (endTime) {
      conditions.push(lte(probeLogs.createdAt, endTime));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const limitNum = normalizePageSize(limit, 100, 200);
    const offsetNum = normalizePageOffset(offset);

    const logs = await db
      .select(PROBE_LOG_SELECT)
      .from(probeLogs)
      .leftJoin(sites, eq(probeLogs.siteId, sites.id))
      .leftJoin(accounts, eq(probeLogs.accountId, accounts.id))
      .leftJoin(accountTokens, eq(probeLogs.tokenId, accountTokens.id))
      .where(whereClause)
      .orderBy(desc(probeLogs.createdAt))
      .limit(limitNum)
      .offset(offsetNum);

    const total = await db
      .select({ count: sql<number>`count(*)` })
      .from(probeLogs)
      .where(whereClause);

    return {
      logs,
      total: total[0]?.count || 0,
      limit: limitNum,
      offset: offsetNum,
    };
  });

  // 清理旧的测活日志
  app.post('/api/probe-logs/cleanup', async (request, _reply) => {
    const rawDays = Number((request.body as { daysToKeep?: unknown } | undefined)?.daysToKeep ?? 7);
    const daysToKeep = Number.isFinite(rawDays) ? Math.min(3650, Math.max(1, Math.trunc(rawDays))) : 7;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffDateStr = cutoffDate.toISOString();

    const result = await db
      .delete(probeLogs)
      .where(sql`${probeLogs.createdAt} < ${cutoffDateStr}`);

    return {
      deletedCount: result.changes || 0,
      cutoffDate: cutoffDateStr,
    };
  });

  // 获取测活筛选选项（站点/账号/令牌/模型去重列表）
  app.get('/api/probe-logs/filters', async (_request, _reply) => {
    const siteRows = await db
      .selectDistinct({
        siteId: probeLogs.siteId,
        siteName: sites.name,
      })
      .from(probeLogs)
      .leftJoin(sites, eq(probeLogs.siteId, sites.id))
      .orderBy(sites.name);

    const accountRows = await db
      .selectDistinct({
        accountId: probeLogs.accountId,
        accountUsername: accounts.username,
      })
      .from(probeLogs)
      .leftJoin(accounts, eq(probeLogs.accountId, accounts.id))
      .orderBy(accounts.username);

    const tokenRows = await db
      .selectDistinct({
        tokenId: probeLogs.tokenId,
        tokenName: accountTokens.name,
        tokenGroup: accountTokens.tokenGroup,
        accountId: probeLogs.accountId,
      })
      .from(probeLogs)
      .leftJoin(accountTokens, eq(probeLogs.tokenId, accountTokens.id))
      .orderBy(accountTokens.name);

    const modelRows = await db
      .selectDistinct({ modelName: probeLogs.modelName })
      .from(probeLogs)
      .orderBy(probeLogs.modelName);

    return {
      sites: siteRows
        .filter((row: { siteId: number | null }) => row.siteId !== null)
        .map((row: { siteId: number; siteName: string | null }) => ({ id: row.siteId, name: row.siteName || `站点 #${row.siteId}` })),
      accounts: accountRows
        .filter((row: { accountId: number | null }) => row.accountId !== null)
        .map((row: { accountId: number; accountUsername: string | null }) => ({ id: row.accountId, username: row.accountUsername || `账号 #${row.accountId}` })),
      tokens: tokenRows
        .filter((row: { tokenId: number | null }) => row.tokenId !== null)
        .map((row: { tokenId: number; tokenName: string | null; tokenGroup: string | null; accountId: number | null }) => ({
          id: row.tokenId,
          name: row.tokenName || `令牌 #${row.tokenId}`,
          group: row.tokenGroup,
          accountId: row.accountId,
        })),
      models: modelRows
        .filter((row: { modelName: string | null }) => row.modelName)
        .map((row: { modelName: string }) => row.modelName),
    };
  });

  // 获取测活统计
  app.get('/api/probe-logs/stats', async (request, _reply) => {
    const { startTime, endTime } = request.query as {
      startTime?: string;
      endTime?: string;
    };

    const conditions: any[] = [];

    if (startTime) {
      conditions.push(gte(probeLogs.createdAt, startTime));
    }

    if (endTime) {
      conditions.push(lte(probeLogs.createdAt, endTime));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const stats = await db
      .select({
        total: sql<number>`count(*)`,
        success: sql<number>`sum(case when status = 'success' then 1 else 0 end)`,
        failed: sql<number>`sum(case when status = 'failed' then 1 else 0 end)`,
        timeout: sql<number>`sum(case when status = 'timeout' then 1 else 0 end)`,
        avgLatencyMs: sql<number>`avg(latency_ms)`,
        totalTokens: sql<number>`sum(tokens_used)`,
        // Probing is billed spend on every attempt: the summary has to show the
        // money, not just how many rows were written.
        totalCost: sql<number>`coalesce(sum(estimated_cost), 0)`,
      })
      .from(probeLogs)
      .where(whereClause);

    return stats[0] || {
      total: 0,
      success: 0,
      failed: 0,
      timeout: 0,
      avgLatencyMs: 0,
      totalTokens: 0,
      totalCost: 0,
    };
  });

  /**
   * Probe runs (batches).
   *
   * One click on "probe all" writes hundreds of rows; a flat list cannot answer
   * "what did the last run do, and what did it cost". Each row here is one
   * `run_id` with its counts and spend, newest first, so the log page can show a
   * batch view and drill into a single run.
   */
  app.get('/api/probe-logs/runs', async (request, _reply) => {
    const {
      siteId,
      accountId,
      tokenId,
      startTime,
      endTime,
      limit = 50,
      offset = 0,
    } = request.query as {
      siteId?: string;
      accountId?: string;
      tokenId?: string;
      startTime?: string;
      endTime?: string;
      limit?: string;
      offset?: string;
    };

    const conditions: any[] = [sql`${probeLogs.runId} is not null`];

    if (siteId) {
      const parsed = parseInt(siteId, 10);
      if (Number.isFinite(parsed) && parsed > 0) conditions.push(eq(probeLogs.siteId, parsed));
    }
    if (accountId) {
      const parsed = parseInt(accountId, 10);
      if (Number.isFinite(parsed) && parsed > 0) conditions.push(eq(probeLogs.accountId, parsed));
    }
    if (tokenId) {
      const parsed = parseInt(tokenId, 10);
      if (Number.isFinite(parsed) && parsed > 0) conditions.push(eq(probeLogs.tokenId, parsed));
    }
    if (startTime) conditions.push(gte(probeLogs.createdAt, startTime));
    if (endTime) conditions.push(lte(probeLogs.createdAt, endTime));

    const whereClause = and(...conditions);
    const limitNum = normalizePageSize(limit, 50, 200);
    const offsetNum = normalizePageOffset(offset);

    const rows = await db
      .select({
        runId: probeLogs.runId,
        siteId: probeLogs.siteId,
        siteName: sites.name,
        probed: sql<number>`count(*)`,
        success: sql<number>`sum(case when ${probeLogs.status} = 'success' then 1 else 0 end)`,
        failed: sql<number>`sum(case when ${probeLogs.status} = 'failed' then 1 else 0 end)`,
        timeout: sql<number>`sum(case when ${probeLogs.status} = 'timeout' then 1 else 0 end)`,
        modelCount: sql<number>`count(distinct ${probeLogs.modelName})`,
        tokenCount: sql<number>`count(distinct ${probeLogs.tokenId})`,
        accountCount: sql<number>`count(distinct ${probeLogs.accountId})`,
        totalCost: sql<number>`coalesce(sum(${probeLogs.estimatedCost}), 0)`,
        totalTokens: sql<number>`coalesce(sum(${probeLogs.tokensUsed}), 0)`,
        startedAt: sql<unknown>`min(${probeLogs.createdAt})`,
        finishedAt: sql<unknown>`max(${probeLogs.createdAt})`,
      })
      .from(probeLogs)
      .leftJoin(sites, eq(probeLogs.siteId, sites.id))
      .where(whereClause)
      .groupBy(probeLogs.runId, probeLogs.siteId, sites.name)
      .orderBy(desc(sql`max(${probeLogs.createdAt})`))
      .limit(limitNum)
      .offset(offsetNum);

    return { runs: rows, limit: limitNum, offset: offsetNum };
  });

  // 获取单个测活日志详情（放在静态路由之后，避免 /filters、/stats 被 :id 吞掉）
  app.get('/api/probe-logs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const log = await db
      .select(PROBE_LOG_SELECT)
      .from(probeLogs)
      .leftJoin(sites, eq(probeLogs.siteId, sites.id))
      .leftJoin(accounts, eq(probeLogs.accountId, accounts.id))
      .leftJoin(accountTokens, eq(probeLogs.tokenId, accountTokens.id))
      .where(eq(probeLogs.id, parseInt(id, 10)))
      .get();

    if (!log) {
      return reply.status(404).send({ error: 'Probe log not found' });
    }

    return log;
  });
}
