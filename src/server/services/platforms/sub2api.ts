import {
  ApiTokenInfo,
  BasePlatformAdapter,
  CheckinResult,
  BalanceInfo,
  CreateApiTokenOptions,
  SubscriptionPlanSummary,
  SubscriptionSummary,
  type DeleteApiTokenResult,
  type ModelPriceCatalogEntry,
  type SiteAnnouncement,
  type UserGroupInfo,
  UserInfo,
} from './base.js';
import { withSiteProxyRequestInit } from '../siteProxy.js';
import { stripTrailingSlashes } from '../urlNormalization.js';
import { parseUsageKeys, parseUsageModels, parseUsageStats, UsageDashboardError } from './usageDashboard.js';
import { withManagementRequestTimeout } from './upstreamRequestTimeout.js';

function normalizeBaseUrl(baseUrl: string): string {
  return stripTrailingSlashes(baseUrl || '');
}

/** Group catalog paging: 50 rows per request, with a hard page cap. */
const SUB2API_GROUP_CATALOG_PAGE_SIZE = 50;
const SUB2API_GROUP_CATALOG_MAX_PAGES = 20;

/**
 * Sub2API adapter.
 *
 * Sub2API uses JWT-based auth with endpoints under /api/v1/*.
 * It does NOT support: login or check-in.
 * Balance is derived from a USD amount returned by /api/v1/auth/me.
 */
export class Sub2ApiAdapter extends BasePlatformAdapter {
  readonly platformName = 'sub2api';

  async getUsageKeyCatalog(baseUrl: string, accessToken: string): Promise<ApiTokenInfo[]> {
    const endpoint = '/api/v1/keys?page=1&page_size=100';
    const response = await this.fetchUsageEndpoint(baseUrl, accessToken, endpoint);
    return this.parseTokenItems(response).map((item) => ({
      upstreamId: item.id, name: item.name, key: item.key, enabled: item.enabled, tokenGroup: item.tokenGroup,
    }));
  }

  private async fetchUsageEndpoint(baseUrl: string, accessToken: string, endpoint: string): Promise<unknown> {
    const { fetch } = await import('undici');
    const url = `${this.resolveManagementBaseUrl(baseUrl)}${endpoint}`;
    const response = await fetch(url, await withSiteProxyRequestInit(url, withManagementRequestTimeout({
      headers: this.buildAuthHeader(accessToken),
    })));
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const seconds = retry && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry || '') - Date.now();
      await response.body?.cancel();
      throw new UsageDashboardError(response.status, Math.max(0, Number.isFinite(seconds) ? seconds : 0));
    }
    return this.parseSub2ApiEnvelope<unknown>(await response.json(), endpoint);
  }

  async getUsageDashboard(baseUrl: string, accessToken: string, input: {
    kind: 'stats' | 'keys' | 'models'; timeZone: string; day: string;
  }) {
    const endpoint = `/api/v1/usage/dashboard/${input.kind === 'keys' ? 'api-keys-usage' : input.kind}`;
    const query = new URLSearchParams({ timezone: input.timeZone });
    if (input.kind === 'models') {
      query.set('start_date', input.day);
      query.set('end_date', input.day);
    }
    const data = await this.fetchUsageEndpoint(baseUrl, accessToken, `${endpoint}?${query}`);
    if (input.kind === 'stats') return parseUsageStats(data);
    if (input.kind === 'keys') return parseUsageKeys(data);
    const range = data as { start_date?: string; end_date?: string };
    if (range.start_date !== input.day || range.end_date !== input.day) throw new Error('上游返回的模型统计日期与请求不一致');
    return parseUsageModels(data);
  }

  private roundCurrency(value: number): number {
    return Math.round(value * 1_000_000) / 1_000_000;
  }

  private parsePositiveInteger(raw: unknown): number | undefined {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
    if (typeof raw === 'string') {
      const parsed = Number.parseInt(raw.trim(), 10);
      if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    }
    return undefined;
  }

  private parseNonNegativeInteger(raw: unknown): number | undefined {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.trunc(raw);
    if (typeof raw === 'string') {
      const parsed = Number.parseInt(raw.trim(), 10);
      if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
    }
    return undefined;
  }

  private parseNonNegativeNumber(raw: unknown): number | undefined {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      return this.roundCurrency(raw);
    }
    if (typeof raw === 'string') {
      const parsed = Number(raw.trim());
      if (Number.isFinite(parsed) && parsed >= 0) {
        return this.roundCurrency(parsed);
      }
    }
    return undefined;
  }

  private parseDateTime(raw: unknown): string | undefined {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      const ms = raw > 10_000_000_000 ? raw : raw * 1000;
      return new Date(ms).toISOString();
    }
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      const ms = numeric > 10_000_000_000 ? numeric : numeric * 1000;
      return new Date(ms).toISOString();
    }

    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    return undefined;
  }

  private parseSubscriptionItem(raw: unknown): SubscriptionPlanSummary | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const item = raw as Record<string, unknown>;
    const group = item.group && typeof item.group === 'object' && !Array.isArray(item.group)
      ? item.group as Record<string, unknown>
      : null;

    const normalized: SubscriptionPlanSummary = {};

    const id = this.parsePositiveInteger(item.id);
    if (id) normalized.id = id;

    const groupId = this.parsePositiveInteger(item.group_id ?? item.groupId ?? group?.id);
    if (groupId) normalized.groupId = groupId;

    const groupNameCandidates = [
      item.group_name,
      item.groupName,
      item.name,
      item.title,
      group?.name,
      group?.title,
    ];
    for (const candidate of groupNameCandidates) {
      if (typeof candidate !== 'string') continue;
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      normalized.groupName = trimmed;
      break;
    }

    if (typeof item.status === 'string' && item.status.trim()) {
      normalized.status = item.status.trim();
    }

    const expiresAt = this.parseDateTime(
      item.expires_at
      ?? item.expiresAt
      ?? item.expired_at
      ?? item.expiredAt
      ?? item.end_at
      ?? item.endAt
      ?? item.end_time
      ?? item.endTime
      ?? item.current_period_end
      ?? item.currentPeriodEnd,
    );
    if (expiresAt) normalized.expiresAt = expiresAt;

    const dailyUsedUsd = this.parseNonNegativeNumber(item.daily_used_usd ?? item.dailyUsedUsd);
    if (dailyUsedUsd !== undefined) normalized.dailyUsedUsd = dailyUsedUsd;

    const dailyLimitUsd = this.parseNonNegativeNumber(item.daily_limit_usd ?? item.dailyLimitUsd);
    if (dailyLimitUsd !== undefined) normalized.dailyLimitUsd = dailyLimitUsd;

    const weeklyUsedUsd = this.parseNonNegativeNumber(item.weekly_used_usd ?? item.weeklyUsedUsd);
    if (weeklyUsedUsd !== undefined) normalized.weeklyUsedUsd = weeklyUsedUsd;

    const weeklyLimitUsd = this.parseNonNegativeNumber(item.weekly_limit_usd ?? item.weeklyLimitUsd);
    if (weeklyLimitUsd !== undefined) normalized.weeklyLimitUsd = weeklyLimitUsd;

    const monthlyUsedUsd = this.parseNonNegativeNumber(
      item.monthly_used_usd
      ?? item.monthlyUsedUsd
      ?? item.used_usd
      ?? item.usedUsd
      ?? item.total_used_usd
      ?? item.totalUsedUsd,
    );
    if (monthlyUsedUsd !== undefined) normalized.monthlyUsedUsd = monthlyUsedUsd;

    const monthlyLimitUsd = this.parseNonNegativeNumber(
      item.monthly_limit_usd
      ?? item.monthlyLimitUsd
      ?? item.limit_usd
      ?? item.limitUsd
      ?? item.total_limit_usd
      ?? item.totalLimitUsd,
    );
    if (monthlyLimitUsd !== undefined) normalized.monthlyLimitUsd = monthlyLimitUsd;

    return Object.keys(normalized).length > 0 ? normalized : null;
  }

  private parseSubscriptionItems(raw: unknown): SubscriptionPlanSummary[] {
    const rawItems = (() => {
      if (Array.isArray(raw)) return raw;
      if (raw && typeof raw === 'object') {
        const body = raw as Record<string, unknown>;
        if (Array.isArray(body.subscriptions)) return body.subscriptions;
        if (Array.isArray(body.items)) return body.items;
        if (Array.isArray(body.list)) return body.list;
        if (Array.isArray(body.data)) return body.data;
      }
      return [];
    })();

    return rawItems
      .map((item) => this.parseSubscriptionItem(item))
      .filter((item): item is SubscriptionPlanSummary => !!item);
  }

  private buildSubscriptionSummary(payload: unknown): SubscriptionSummary {
    const body = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const subscriptions = this.parseSubscriptionItems(payload);
    const activeCount = this.parseNonNegativeInteger(body.active_count ?? body.activeCount);
    const totalUsedUsd = this.parseNonNegativeNumber(body.total_used_usd ?? body.totalUsedUsd);
    const inferredUsedUsd = subscriptions.reduce((sum, item) => sum + (item.monthlyUsedUsd || 0), 0);

    return {
      activeCount: activeCount ?? subscriptions.length,
      totalUsedUsd: totalUsedUsd ?? this.roundCurrency(inferredUsedUsd),
      subscriptions,
    };
  }

  private async fetchSubscriptionSummary(baseUrl: string, accessToken: string): Promise<SubscriptionSummary | undefined> {
    const headers = this.buildAuthHeader(accessToken);
    const summaryEndpoint = '/api/v1/subscriptions/summary';

    try {
      const res = await this.fetchJson<any>(`${baseUrl}${summaryEndpoint}`, { headers });
      const data = this.parseSub2ApiEnvelope<any>(res, summaryEndpoint);
      return this.buildSubscriptionSummary(data);
    } catch {}

    const fallbackEndpoints = ['/api/v1/subscriptions/active'];
    for (const endpoint of fallbackEndpoints) {
      try {
        const res = await this.fetchJson<any>(`${baseUrl}${endpoint}`, { headers });
        const data = this.parseSub2ApiEnvelope<any>(res, endpoint);
        return this.buildSubscriptionSummary(data);
      } catch {}
    }

    // Every credential/endpoint variant failed: leave a trace instead of a bare
    // null, otherwise the caller only sees "nothing worked".
    console.warn('[sub2api] fetchSubscriptionSummary: all variants failed');
    return undefined;
  }

  private stripBearerPrefix(value?: string | null): string {
    const trimmed = (value || '').trim();
    if (!trimmed) return '';
    return trimmed.replace(/^bearer\s+/i, '').trim();
  }

  private normalizeTokenKeyForCompare(value?: string | null): string {
    return this.stripBearerPrefix(value);
  }

  private buildAuthHeader(accessToken: string): Record<string, string> {
    const normalized = this.stripBearerPrefix(accessToken);
    return { Authorization: `Bearer ${normalized}` };
  }

  private parseTokenEnabled(status: unknown): boolean {
    if (typeof status === 'boolean') return status;
    if (typeof status === 'number') return status === 1;
    if (typeof status !== 'string') return true;
    const normalized = status.trim().toLowerCase();
    if (!normalized) return true;
    if (['inactive', 'disabled', 'false', '0', 'off'].includes(normalized)) return false;
    if (['active', 'enabled', 'true', '1', 'on'].includes(normalized)) return true;
    return true;
  }

  private parseTokenItems(payload: any): Array<{ id: number; key: string; name: string; enabled: boolean; tokenGroup: string | null }> {
    const source = payload?.data ?? payload;
    const rawItems = (() => {
      if (Array.isArray(source)) return source;
      if (Array.isArray(source?.items)) return source.items;
      if (Array.isArray(source?.list)) return source.list;
      if (Array.isArray(source?.data)) return source.data;
      return [];
    })();

    const items: Array<{ id: number; key: string; name: string; enabled: boolean; tokenGroup: string | null }> = [];
    for (const item of rawItems) {
      const key = typeof item?.key === 'string' ? item.key.trim() : '';
      if (!key) continue;
      const id = Number.parseInt(String(item?.id), 10);
      if (!Number.isFinite(id) || id <= 0) continue;
      const name = typeof item?.name === 'string' && item.name.trim()
        ? item.name.trim()
        : `token-${id}`;
      const tokenGroup = (() => {
        const fromNumeric = Number.parseInt(String(item?.group_id ?? item?.groupId ?? ''), 10);
        if (Number.isFinite(fromNumeric) && fromNumeric > 0) return String(fromNumeric);
        const fromText = typeof item?.group_name === 'string'
          ? item.group_name.trim()
          : (typeof item?.group === 'string' ? item.group.trim() : '');
        return fromText || null;
      })();
      items.push({
        id,
        key,
        name,
        enabled: this.parseTokenEnabled(item?.status),
        tokenGroup,
      });
    }
    return items;
  }

  private parseGroupStatus(raw: unknown): UserGroupInfo['status'] {
    if (typeof raw === 'boolean') return raw ? 'active' : 'inactive';
    if (typeof raw === 'number') {
      if (raw === 1) return 'active';
      if (raw === 0) return 'inactive';
      return 'unknown';
    }
    if (typeof raw !== 'string') return 'unknown';
    const normalized = raw.trim().toLowerCase();
    if (['active', 'enabled', 'enable', 'on', 'normal', '1', 'true'].includes(normalized)) return 'active';
    if (['inactive', 'disabled', 'disable', 'off', 'deleted', 'archived', '0', 'false'].includes(normalized)) return 'inactive';
    return 'unknown';
  }

  private parseGroupRate(raw: unknown): number | null {
    const parsed = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? '').trim());
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  /**
   * Parse a group catalog payload into display entries.
   *
   * `/api/v1/groups/available` answers with the full objects we need
   * (`id` / `name` / `status` / `rate_multiplier` / `platform`); the older
   * `group_id`-only shapes are still accepted so the fallback endpoints keep
   * working. The previous parser kept only keys, which is why the UI showed bare
   * group ids and had no status or multiplier to render — and it dropped
   * `platform`, the model vendor the group serves (`openai`, `deepseek`, …).
   */
  private parseGroupCatalog(payload: any): UserGroupInfo[] {
    const source = payload?.data ?? payload;
    const rawItems = (() => {
      if (Array.isArray(source)) return source;
      if (Array.isArray(source?.items)) return source.items;
      if (Array.isArray(source?.list)) return source.list;
      if (Array.isArray(source?.groups)) return source.groups;
      if (Array.isArray(source?.data)) return source.data;
      if (source && typeof source === 'object') {
        // name -> info maps (new-api style) stay tolerated.
        return Object.entries(source as Record<string, unknown>).map(([name, value]) => (
          value && typeof value === 'object'
            ? { name, ...(value as Record<string, unknown>) }
            : { name, rate_multiplier: value }
        ));
      }
      return [];
    })();

    const catalog: UserGroupInfo[] = [];
    const seen = new Set<string>();

    for (const item of rawItems) {
      if (item == null) continue;

      if (typeof item === 'string' || typeof item === 'number') {
        const name = String(item).trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        catalog.push({ id: null, name, status: 'unknown', rateMultiplier: null, vendor: null });
        continue;
      }

      if (typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;

      let id: string | null = null;
      for (const candidate of [record.group_id, record.groupId, record.id, record.value]) {
        const parsed = Number.parseInt(String(candidate ?? ''), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          id = String(parsed);
          break;
        }
      }

      let name = '';
      for (const candidate of [record.name, record.group_name, record.groupName, record.title, record.label, record.code]) {
        if (typeof candidate !== 'string') continue;
        const normalized = candidate.trim();
        if (!normalized) continue;
        name = normalized;
        break;
      }
      if (!name) name = id || '';
      if (!name) continue;

      const key = id ? `id:${id}` : `name:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const status = this.parseGroupStatus(
        record.status ?? record.state ?? record.enabled ?? record.is_active ?? record.isActive,
      );
      const rateMultiplier = this.parseGroupRate(
        record.rate_multiplier
        ?? record.rateMultiplier
        ?? record.group_ratio
        ?? record.ratio
        ?? record.rate
        ?? record.multiplier,
      );

      // Model vendor: `platform` on /api/v1/groups/available ("openai",
      // "deepseek", …). Normalised to lower case so the UI can group/label it
      // without caring about the upstream's casing.
      const vendor = (() => {
        for (const candidate of [record.platform, record.vendor, record.provider]) {
          if (typeof candidate !== 'string') continue;
          const normalized = candidate.trim().toLowerCase();
          if (normalized) return normalized;
        }
        return null;
      })();

      catalog.push({ id, name, status, rateMultiplier, vendor });
    }

    return catalog;
  }

  private async listGroups(baseUrl: string, accessToken: string): Promise<string[]> {
    const catalog = await this.getUserGroupCatalog(baseUrl, accessToken);
    return Array.from(new Set(catalog.map((group) => group.id || group.name).filter(Boolean)));
  }


  private parseGroupIdsFromTokenPayload(payload: any): string[] {
    const source = payload?.data ?? payload;
    const rawItems = (() => {
      if (Array.isArray(source)) return source;
      if (Array.isArray(source?.items)) return source.items;
      if (Array.isArray(source?.list)) return source.list;
      if (Array.isArray(source?.data)) return source.data;
      return [];
    })();

    const groups: string[] = [];
    for (const item of rawItems) {
      if (!item || typeof item !== 'object') continue;
      const groupId = Number.parseInt(String((item as any).group_id ?? (item as any).groupId ?? ''), 10);
      if (!Number.isFinite(groupId) || groupId <= 0) continue;
      groups.push(String(groupId));
    }
    return Array.from(new Set(groups));
  }

  private async inferGroupsFromKeys(baseUrl: string, accessToken: string): Promise<string[]> {
    const endpoints = [
      '/api/v1/keys?page=1&page_size=100',
      '/api/v1/api-keys?page=1&page_size=100',
    ];

    const headers = this.buildAuthHeader(accessToken);
    for (const endpoint of endpoints) {
      try {
        const res = await this.fetchJson<any>(`${baseUrl}${endpoint}`, {
          headers,
        });
        const parsed = (() => {
          try {
            return this.parseSub2ApiEnvelope<any>(res, endpoint);
          } catch {
            return res;
          }
        })();
        const groups = this.parseGroupIdsFromTokenPayload(parsed);
        if (groups.length > 0) return groups;
      } catch {}
    }

    // Every credential/endpoint variant failed: leave a trace instead of a bare
    // null, otherwise the caller only sees "nothing worked".
    console.warn('[sub2api] inferGroupsFromKeys: all variants failed');
    return [];
  }

  private extractModelIds(payload: any): string[] {
    const source = payload?.data ?? payload;
    const rawModels = (() => {
      if (Array.isArray(source)) return source;
      if (Array.isArray(source?.items)) return source.items;
      if (Array.isArray(source?.models)) return source.models;
      return [];
    })();

    const models = rawModels
      .map((item: any) => (typeof item === 'string' ? item : item?.id ?? item?.name))
      .map((value: unknown) => String(value || '').trim())
      .map((value: string) => value.replace(/^models\//i, ''))
      .filter(Boolean);
    return Array.from(new Set(models));
  }

  private resolveModelEndpoints(baseUrl: string): string[] {
    const normalizedBase = normalizeBaseUrl(baseUrl);
    if (!normalizedBase) return [];
    if (/\/models$/i.test(normalizedBase)) return [normalizedBase];
    if (/\/(?:antigravity\/)?v\d+(?:\.\d+)?(?:beta)?$/i.test(normalizedBase)) {
      return [`${normalizedBase}/models`];
    }
    if (/\/antigravity$/i.test(normalizedBase)) {
      return [
        `${normalizedBase}/v1/models`,
        `${normalizedBase}/v1beta/models`,
      ];
    }
    return [
      `${normalizedBase}/v1/models`,
      `${normalizedBase}/api/v1/models`,
      `${normalizedBase}/v1beta/models`,
      `${normalizedBase}/antigravity/v1beta/models`,
    ];
  }

  private resolveManagementBaseUrl(baseUrl: string): string {
    let normalizedBase = normalizeBaseUrl(baseUrl);
    if (!normalizedBase) return normalizedBase;

    const suffixes = [
      '/models',
      '/antigravity',
      '/antigravity/v1beta',
      '/antigravity/v1',
      '/api/v1',
      '/v1beta',
      '/v1',
    ];

    let changed = true;
    while (changed) {
      changed = false;
      for (const suffix of suffixes) {
        if (!normalizedBase.toLowerCase().endsWith(suffix)) continue;
        const trimmed = normalizeBaseUrl(normalizedBase.slice(0, -suffix.length));
        if (!trimmed || trimmed === normalizedBase) continue;
        normalizedBase = trimmed;
        changed = true;
        break;
      }
    }

    return normalizedBase;
  }

  private async listApiKeys(baseUrl: string, accessToken: string): Promise<Array<{ id: number; key: string; name: string; enabled: boolean; tokenGroup: string | null }>> {
    const endpoints = [
      '/api/v1/keys?page=1&page_size=100',
      '/api/v1/api-keys?page=1&page_size=100',
    ];

    const headers = this.buildAuthHeader(accessToken);
    for (const endpoint of endpoints) {
      try {
        const res = await this.fetchJson<any>(`${baseUrl}${endpoint}`, {
          headers,
        });
        const data = this.parseSub2ApiEnvelope<any>(res, endpoint);
        const items = this.parseTokenItems(data);
        if (items.length > 0) return items;
      } catch {}
    }

    // Every credential/endpoint variant failed: leave a trace instead of a bare
    // null, otherwise the caller only sees "nothing worked".
    console.warn('[sub2api] listApiKeys: all variants failed');
    return [];
  }

  private async fetchModelsByToken(baseUrl: string, token: string): Promise<string[]> {
    const authToken = this.normalizeTokenKeyForCompare(token);
    if (!authToken) return [];

    for (const url of this.resolveModelEndpoints(baseUrl)) {
      try {
        const res = await this.fetchJson<any>(url, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        const models = this.extractModelIds(res);
        if (models.length > 0) return models;
      } catch {}
    }

    // Every credential/endpoint variant failed: leave a trace instead of a bare
    // null, otherwise the caller only sees "nothing worked".
    console.warn('[sub2api] fetchModelsByToken: all variants failed');
    return [];
  }

  private resolveExpiresInDays(expiredTime?: number): number | undefined {
    if (!Number.isFinite(expiredTime)) return undefined;
    const raw = Math.trunc(expiredTime as number);
    if (raw <= 0) return undefined;
    const expiresAtMs = raw > 10_000_000_000 ? raw : raw * 1000;
    const deltaMs = expiresAtMs - Date.now();
    const days = Math.max(1, Math.ceil(deltaMs / (24 * 60 * 60 * 1000)));
    return Number.isFinite(days) ? Math.min(days, 3650) : undefined;
  }

  async detect(url: string): Promise<boolean> {
    const normalized = (url || '').toLowerCase();
    if (normalized.includes('sub2api')) return true;

    const base = normalizeBaseUrl(url);
    const { fetch } = await import('undici');
    const probeEndpoint = async (path: string) => {
      try {
        return await fetch(`${base}${path}`, await withSiteProxyRequestInit(`${base}${path}`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        }));
      } catch {
        return null;
      }
    };

    const matchSub2ApiErrorEnvelope = async (res: {
      headers: { get(name: string): string | null };
      json: () => Promise<unknown>;
    } | null): Promise<boolean> => {
      if (!res) return false;
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes('application/json')) return false;
      const body = await res.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') return false;
      const rawCode = body.code;
      const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
      const message = typeof body.message === 'string' ? body.message.trim().toLowerCase() : '';

      if (code === 'UNAUTHORIZED' || code === 'API_KEY_REQUIRED') return true;
      if (
        message.includes('authorization header is required')
        || message.includes('api key is required')
      ) {
        return true;
      }

      // Some Sub2API variants return numeric success envelope for authorized calls.
      if (typeof rawCode === 'number' && rawCode === 0) {
        return Object.prototype.hasOwnProperty.call(body, 'data');
      }

      return false;
    };

    const authProbe = await probeEndpoint('/api/v1/auth/me');
    if (await matchSub2ApiErrorEnvelope(authProbe)) return true;

    const modelsProbe = await probeEndpoint('/v1/models');
    if (await matchSub2ApiErrorEnvelope(modelsProbe)) return true;

    // Last fallback: many Sub2API UIs expose an identifying title on root.
    const rootProbe = await probeEndpoint('/');
    if (!rootProbe) return false;
    const rootType = rootProbe.headers.get('content-type') || '';
    if (!rootType.toLowerCase().includes('text/html')) return false;
    const rootText = await rootProbe.text().catch(() => '');
    return /<title>\s*sub2api\b/i.test(rootText);
  }

  /**
   * Parse the Sub2API { code, message, data } envelope.
   * code === 0 means success; anything else is an error.
   */
  private parseSub2ApiEnvelope<T>(body: any, endpoint: string): T {
    if (!body || typeof body !== 'object') {
      throw new Error(`Invalid response from ${endpoint}`);
    }
    if (typeof body.code !== 'number') {
      throw new Error(`Invalid response format from ${endpoint}`);
    }
    if (body.code !== 0) {
      const message = typeof body.message === 'string' && body.message.trim()
        ? body.message.trim()
        : `Error code ${body.code} from ${endpoint}`;
      throw new Error(message);
    }
    if (body.data === undefined) {
      throw new Error(`Missing data in response from ${endpoint}`);
    }
    return body.data as T;
  }

  /**
   * Extract display name: prefer username, fall back to email local part.
   */
  private getDisplayName(username?: string, email?: string): string {
    const name = (username || '').trim();
    if (name) return name;
    const mail = (email || '').trim();
    if (!mail) return '';
    const atIndex = mail.indexOf('@');
    return atIndex > 0 ? mail.slice(0, atIndex) : mail;
  }

  /**
   * Fetch user data from /api/v1/auth/me.
   */
  private async fetchAuthMe(baseUrl: string, accessToken: string): Promise<{
    id: number;
    username: string;
    email: string;
    balance: number;
  }> {
    const endpoint = '/api/v1/auth/me';
    const res = await this.fetchJson<any>(`${baseUrl}${endpoint}`, {
      headers: this.buildAuthHeader(accessToken),
    });
    const data = this.parseSub2ApiEnvelope<any>(res, endpoint);

    const id = typeof data.id === 'number' ? data.id
      : typeof data.id === 'string' ? Number.parseInt(data.id, 10)
      : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error(`Invalid user ID in response from ${endpoint}`);
    }

    const balance = typeof data.balance === 'number' ? data.balance
      : typeof data.balance === 'string' ? Number.parseFloat(data.balance)
      : 0;

    return {
      id,
      username: typeof data.username === 'string' ? data.username : '',
      email: typeof data.email === 'string' ? data.email : '',
      balance: Number.isFinite(balance) ? balance : 0,
    };
  }

  /**
   * Convert USD balance to internal quota unit.
   * Uses the same conversion factor as all-api-hub (500000 per USD).
   */
  private usdToQuota(balanceUsd: number): number {
    return Math.round(Math.max(0, balanceUsd) * 500000);
  }

  // --- Login: Not supported (JWT only) ---
  override async login(
    _baseUrl: string,
    _username: string,
    _password: string,
  ): Promise<{ success: false; message: string }> {
    return { success: false, message: 'Sub2API uses JWT authentication; login is not supported' };
  }

  // --- User Info ---
  override async getUserInfo(baseUrl: string, accessToken: string): Promise<UserInfo | null> {
    try {
      const user = await this.fetchAuthMe(baseUrl, accessToken);
      return {
        username: this.getDisplayName(user.username, user.email),
        email: user.email || undefined,
      };
    } catch {
      return null;
    }
  }

  // --- Check-in: Not supported ---
  async checkin(
    _baseUrl: string,
    _accessToken: string,
  ): Promise<CheckinResult> {
    return { success: false, message: 'Check-in is not supported by Sub2API' };
  }

  // --- Balance ---
  async getBalance(baseUrl: string, accessToken: string): Promise<BalanceInfo> {
    const normalizedBase = normalizeBaseUrl(baseUrl);
    const [user, subscriptionSummary] = await Promise.all([
      this.fetchAuthMe(normalizedBase, accessToken),
      this.fetchSubscriptionSummary(normalizedBase, accessToken),
    ]);
    const quotaValue = this.usdToQuota(user.balance);
    // Sub2API only provides current balance, no usage breakdown
    return {
      balance: quotaValue / 500000,
      used: 0,
      quota: quotaValue / 500000,
      subscriptionSummary,
    };
  }

  // --- Models: Standard OpenAI-compatible endpoint ---
  async getModels(baseUrl: string, apiToken: string): Promise<string[]> {
    const normalizedBase = normalizeBaseUrl(baseUrl);
    const managementBase = this.resolveManagementBaseUrl(normalizedBase);
    const directModels = await this.fetchModelsByToken(normalizedBase, apiToken);
    if (directModels.length > 0) return directModels;

    // Session JWT cannot access /v1/models directly; discover a user key first.
    const discoveredApiToken = await this.getApiToken(managementBase, apiToken);
    if (!discoveredApiToken) return [];
    if (this.normalizeTokenKeyForCompare(discoveredApiToken) === this.normalizeTokenKeyForCompare(apiToken)) {
      return [];
    }
    return this.fetchModelsByToken(normalizedBase, discoveredApiToken);
  }

  override async getSiteAnnouncements(baseUrl: string, accessToken: string): Promise<SiteAnnouncement[]> {
    try {
      const endpoint = '/api/v1/announcements?page=1&page_size=100';
      const res = await this.fetchJson<any>(`${normalizeBaseUrl(baseUrl)}${endpoint}`, {
        headers: this.buildAuthHeader(accessToken),
      });
      const data = this.parseSub2ApiEnvelope<any>(res, endpoint);
      const rawItems = Array.isArray(data)
        ? data
        : (Array.isArray(data?.items) ? data.items : []);
      const rows: SiteAnnouncement[] = [];
      for (const item of rawItems) {
        const id = Number.parseInt(String(item?.id), 10);
        if (!Number.isFinite(id) || id <= 0) continue;
        const title = typeof item?.title === 'string' ? item.title.trim() : '';
        const content = typeof item?.content === 'string' ? item.content.trim() : '';
        if (!title && !content) continue;
        rows.push({
          sourceKey: `announcement:${id}`,
          title: title || `Announcement ${id}`,
          content: content || title,
          level: 'info',
          startsAt: typeof item?.starts_at === 'string' ? item.starts_at : undefined,
          endsAt: typeof item?.ends_at === 'string' ? item.ends_at : undefined,
          upstreamCreatedAt: typeof item?.created_at === 'string' ? item.created_at : undefined,
          upstreamUpdatedAt: typeof item?.updated_at === 'string' ? item.updated_at : undefined,
          rawPayload: item,
        });
      }
      return rows;
    } catch {
      return [];
    }
  }

  override async getApiTokens(baseUrl: string, accessToken: string): Promise<ApiTokenInfo[]> {
    try {
      const keys = await this.listApiKeys(normalizeBaseUrl(baseUrl), accessToken);
      return keys.map((item) => {
        const tokenInfo: ApiTokenInfo = {
          name: item.name,
          key: item.key,
          enabled: item.enabled,
        };
        if (item.tokenGroup) tokenInfo.tokenGroup = item.tokenGroup;
        return tokenInfo;
      });
    } catch {
      return [];
    }
  }

  override async getApiToken(baseUrl: string, accessToken: string): Promise<string | null> {
    const tokens = await this.getApiTokens(baseUrl, accessToken);
    return tokens.find((token) => token.enabled !== false)?.key || tokens[0]?.key || null;
  }

  override async getUserGroups(baseUrl: string, accessToken: string): Promise<string[]> {
    const normalizedBase = normalizeBaseUrl(baseUrl);
    const directGroups = await this.listGroups(normalizedBase, accessToken);
    if (directGroups.length > 0) return directGroups;

    const inferredFromKeys = await this.inferGroupsFromKeys(normalizedBase, accessToken);
    if (inferredFromKeys.length > 0) return inferredFromKeys;

    return ['default'];
  }

  override async getUserGroupCatalog(baseUrl: string, accessToken: string): Promise<UserGroupInfo[]> {
    const normalizedBase = normalizeBaseUrl(baseUrl);
    // Query strings are added by the pager, so endpoints stay path-only.
    const endpoints = ['/api/v1/groups/available', '/api/v1/groups', '/api/v1/group'];

    for (const endpoint of endpoints) {
      try {
        const catalog = await this.fetchGroupCatalogPaged(normalizedBase, accessToken, endpoint);
        if (catalog.length > 0) return catalog;
      } catch {
        // Unsupported/absent endpoint: try the next variant.
      }
    }

    // Fallback: the key list only carries `group_id`, so the id doubles as the
    // display name rather than leaving the UI blank.
    const inferredIds = await this.inferGroupsFromKeys(normalizedBase, accessToken);
    if (inferredIds.length > 0) {
      return inferredIds.map((id) => ({ id, name: id, status: 'unknown' as const, rateMultiplier: null, vendor: null }));
    }

    console.warn('[sub2api] getUserGroupCatalog: all variants failed');
    return [];
  }

  /**
   * Absolute per-token prices, published by the same catalog payload that
   * carries the groups (`platforms[].supported_models[].pricing`). sub2api has
   * no new-api ratio table, so this is the only truthful price source.
   */
  async getModelPriceCatalog(baseUrl: string, accessToken: string): Promise<ModelPriceCatalogEntry[]> {
    const normalizedBase = normalizeBaseUrl(baseUrl);
    const endpoints = ['/api/v1/groups/available', '/api/v1/groups', '/api/v1/group'];
    const headers = this.buildAuthHeader(accessToken);

    for (const endpoint of endpoints) {
      try {
        const res = await this.fetchJson<any>(
          `${normalizedBase}${endpoint}?page=1&page_size=${SUB2API_GROUP_CATALOG_PAGE_SIZE}`,
          { headers },
        );
        let parsed: any = res;
        try {
          parsed = this.parseSub2ApiEnvelope<any>(res, endpoint);
        } catch {
          parsed = res;
        }
        const entries = this.parseModelPriceCatalog(parsed);
        if (entries.length > 0) return entries;
      } catch {
        // Unsupported/absent endpoint: try the next variant.
      }
    }

    return [];
  }

  private parseModelPriceCatalog(payload: unknown): ModelPriceCatalogEntry[] {
    const byModel = new Map<string, ModelPriceCatalogEntry>();

    const readPrice = (value: unknown): number | null => {
      const parsed = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    };

    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      const models = record.supported_models ?? record.supportedModels;
      if (Array.isArray(models)) {
        for (const item of models) {
          if (!item || typeof item !== 'object') continue;
          const model = item as Record<string, unknown>;
          const name = typeof model.name === 'string' ? model.name.trim() : '';
          const pricing = model.pricing;
          if (!name || !pricing || typeof pricing !== 'object') continue;
          const prices = pricing as Record<string, unknown>;
          const input = readPrice(prices.input_price ?? prices.inputPrice);
          const output = readPrice(prices.output_price ?? prices.outputPrice);
          if (input === null || output === null) continue;
          byModel.set(name.toLowerCase(), {
            modelName: name,
            input,
            output,
            cacheRead: readPrice(prices.cache_read_price ?? prices.cacheReadPrice) ?? 0,
            cacheWrite: readPrice(prices.cache_write_price ?? prices.cacheWritePrice) ?? 0,
          });
        }
      }
      for (const value of Object.values(record)) visit(value);
    };

    visit(payload);
    return [...byModel.values()];
  }

  /**
   * Walk a group catalog endpoint page by page (50 rows each) until upstream
   * stops returning rows.
   *
   * Two stop guards are needed: a page shorter than the requested size is the
   * last page, and a page that adds no new group means the endpoint ignored the
   * paging parameters (sub2api's `/api/v1/groups/available` answers with the
   * whole list on every page), so continuing would refetch identical rows
   * forever.
   */
  private async fetchGroupCatalogPaged(
    baseUrl: string,
    accessToken: string,
    endpoint: string,
  ): Promise<UserGroupInfo[]> {
    const collected: UserGroupInfo[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= SUB2API_GROUP_CATALOG_MAX_PAGES; page += 1) {
      const items = await this.fetchGroupCatalogPage(baseUrl, accessToken, endpoint, page);
      if (items.length === 0) break;

      let added = 0;
      for (const item of items) {
        const key = item.id ? `id:${item.id}` : `name:${item.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(item);
        added += 1;
      }

      if (items.length < SUB2API_GROUP_CATALOG_PAGE_SIZE || added === 0) break;
    }

    return collected;
  }

  private async fetchGroupCatalogPage(
    baseUrl: string,
    accessToken: string,
    endpoint: string,
    page: number,
  ): Promise<UserGroupInfo[]> {
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `${baseUrl}${endpoint}${separator}page=${page}&page_size=${SUB2API_GROUP_CATALOG_PAGE_SIZE}`;
    const res = await this.fetchJson<any>(url, { headers: this.buildAuthHeader(accessToken) });
    const parsed = (() => {
      try {
        return this.parseSub2ApiEnvelope<any>(res, endpoint);
      } catch {
        return res;
      }
    })();
    return this.parseGroupCatalog(parsed);
  }

  override async createApiToken(
    baseUrl: string,
    accessToken: string,
    _platformUserId?: number,
    options?: CreateApiTokenOptions,
  ): Promise<boolean> {
    const normalizedBase = normalizeBaseUrl(baseUrl);
    const payload: Record<string, unknown> = {
      name: (options?.name || '').trim() || 'metapi',
    };

    const groupId = Number.parseInt((options?.group || '').trim(), 10);
    if (Number.isFinite(groupId) && groupId > 0) {
      payload.group_id = groupId;
    }

    const expiresInDays = this.resolveExpiresInDays(options?.expiredTime);
    if (expiresInDays) {
      payload.expires_in_days = expiresInDays;
    }

    if (options?.unlimitedQuota === false && Number.isFinite(options.remainQuota)) {
      payload.quota = Math.max(0, Number(options.remainQuota));
    }

    const endpoints = ['/api/v1/keys', '/api/v1/api-keys'];
    const headers = this.buildAuthHeader(accessToken);
    for (const endpoint of endpoints) {
      try {
        const res = await this.fetchJson<any>(`${normalizedBase}${endpoint}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });
        this.parseSub2ApiEnvelope<any>(res, endpoint);
        return true;
      } catch {}
    }

    // Every credential/endpoint variant failed: leave a trace instead of a bare
    // null, otherwise the caller only sees "nothing worked".
    console.warn('[sub2api] createApiToken: all variants failed');
    return false;
  }

  override async deleteApiToken(
    baseUrl: string,
    accessToken: string,
    tokenKey: string,
  ): Promise<DeleteApiTokenResult> {
    const targetKey = this.normalizeTokenKeyForCompare(tokenKey);
    if (!targetKey) return 'unconfirmed';

    const normalizedBase = normalizeBaseUrl(baseUrl);
    let tokenId: number | null = null;
    try {
      const items = await this.listApiKeys(normalizedBase, accessToken);
      tokenId = items.find((item) => this.normalizeTokenKeyForCompare(item.key) === targetKey)?.id || null;
    } catch {
      return 'unconfirmed';
    }

    // `listApiKeys` is a single page (page_size=100), so it cannot prove that a
    // missing key does not exist on a later page — keep the local row unless
    // the key was actually found and revoked.
    if (!tokenId) return 'unconfirmed';

    const endpoints = [
      `/api/v1/keys/${tokenId}`,
      `/api/v1/api-keys/${tokenId}`,
    ];
    const headers = this.buildAuthHeader(accessToken);
    for (const endpoint of endpoints) {
      try {
        const res = await this.fetchJson<any>(`${normalizedBase}${endpoint}`, {
          method: 'DELETE',
          headers,
        });
        this.parseSub2ApiEnvelope<any>(res, endpoint);
        return 'deleted';
      } catch {}
    }

    // Every credential/endpoint variant failed: leave a trace instead of a bare
    // null, otherwise the caller only sees "nothing worked".
    console.warn('[sub2api] deleteApiToken: all variants failed');
    return 'unconfirmed';
  }
}
