import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { copyText } from '../../clipboard.js';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import CenteredModal from '../../components/CenteredModal.js';
import ResponsiveFilterPanel from '../../components/ResponsiveFilterPanel.js';
import ResponsiveFormGrid from '../../components/ResponsiveFormGrid.js';
import { useToast } from '../../components/Toast.js';
import { formatDateTimeLocal } from '../helpers/checkinLogTime.js';
import {
  isTruthyFlag,
  parsePositiveInt,
  resolveAccountCredentialMode,
} from '../helpers/accountConnection.js';
import ModernSelect from '../../components/ModernSelect.js';
import { MobileCard, MobileField } from '../../components/MobileCard.js';
import { useIsMobile } from '../../components/useIsMobile.js';
import { emitTokenCoverageChanged } from '../../dataEvents.js';
import { pageForItemIndex } from '../../components/clientPagination.js';
import PaginationControls from '../../components/PaginationControls.js';
import { useClientPagination } from '../../components/useClientPagination.js';
import { usePersistedPageSize } from '../../components/usePersistedPageSize.js';
import DeleteConfirmModal from '../../components/DeleteConfirmModal.js';
import { clearFocusParams, readFocusTokenId } from '../helpers/navigationFocus.js';
import { tr } from '../../i18n.js';
import { StatusText, StatusPill } from '../../components/StatusText.js';

type SyncStatus = 'success' | 'skipped' | 'failed';
type TokensPanelProps = {
  embedded?: boolean;
  onEmbeddedActionsChange?: (actions: React.ReactNode | null) => void;
  siteId?: number;
};

type AccountTokenSyncResult = {
  status?: string;
  success?: boolean;
  synced?: boolean;
  message?: string;
  reason?: string;
  created?: number;
  updated?: number;
  maskedPending?: number;
  pendingTokenIds?: number[];
  accountId?: number;
  accountName?: string;
  account?: {
    id?: number;
    username?: string;
  };
  tokens?: Array<{
    id?: number;
    name?: string;
    tokenGroup?: string | null;
    enabled?: boolean;
    isDefault?: boolean;
    valueStatus?: string;
    updatedAt?: string;
  }>;
  coverageRefresh?: {
    refresh?: Array<{
      accountId?: number;
      refreshed?: boolean;
      status?: string;
      modelCount?: number;
      modelsPreview?: string[];
      errorMessage?: string;
    }>;
    rebuild?: {
      success?: boolean;
      result?: {
        createdChannels?: number;
        removedChannels?: number;
      } | null;
      error?: string;
    } | null;
  };
};

type SyncableAccount = {
  id: number;
  siteId?: number;
  username?: string | null;
  accessToken?: string | null;
  status?: string | null;
  credentialMode?: string | null;
  capabilities?: {
    proxyOnly?: boolean;
  } | null;
  site?: {
    id?: number;
    status?: string | null;
    name?: string | null;
  } | null;
};

const ACCOUNT_SELECT_SEARCH_PLACEHOLDER = tr('筛选账号（名称 / 站点）');

const isAccountSyncable = (account: any) =>
  resolveAccountCredentialMode(account) === 'session'
  && account?.status === 'active'
  && account?.site?.status !== 'disabled';

/**
 * Account that can *create* a token: it only needs a session credential and an
 * enabled site. Status is deliberately not part of this test — an `expired`
 * account still holds a working access token (only the refresh token is gone),
 * and the server-side create path accepts it. Filtering those accounts out left
 * the "所属账号" picker empty with no explanation.
 */
const isSessionTokenAccount = (account: any) =>
  resolveAccountCredentialMode(account) === 'session'
  && account?.site?.status !== 'disabled';

const accountStatusSuffix = (account: any): string => {
  const status = String(account?.status || '').trim().toLowerCase();
  if (!status || status === 'active') return '';
  if (status === 'expired') return ` · ${tr('会话已过期')}`;
  if (status === 'disabled') return ` · ${tr('已禁用')}`;
  return ` · ${status}`;
};

const resolveSyncStatus = (result: AccountTokenSyncResult | null | undefined): SyncStatus => {
  const raw = String(result?.status || '').toLowerCase();
  if (raw === 'failed' || raw === 'error') return 'failed';
  if (raw === 'skipped' || raw === 'skip') return 'skipped';
  if (raw === 'success' || raw === 'ok' || raw === 'succeeded') return 'success';
  if (result?.success === false) return 'failed';
  if (result?.synced === false) return 'skipped';
  return 'success';
};

const resolveSyncMessage = (result: AccountTokenSyncResult | null | undefined, fallback: string) => {
  const message = typeof result?.message === 'string' ? result.message.trim() : '';
  return message || fallback;
};

const isMaskedPendingToken = (token: any): boolean => token?.valueStatus === 'masked_pending';

/**
 * Upstream group metadata. Tokens persist only the group key (a numeric id on
 * sub2api), so the name/status/multiplier shown in the UI come from the
 * account's group catalog returned alongside `/api/account-tokens/groups/:id`.
 */
type TokenGroupDetail = {
  id: string | null;
  name: string;
  status: string;
  rateMultiplier: number | null;
  /** Model vendor the group serves (sub2api `platform`), null when unpublished. */
  vendor: string | null;
};

const parseGroupDetails = (res: any): TokenGroupDetail[] => (
  Array.isArray(res?.groupDetails)
    ? res.groupDetails
      .map((item: any): TokenGroupDetail => ({
        id: item?.id != null && String(item.id).trim() !== '' ? String(item.id).trim() : null,
        name: String(item?.name || '').trim(),
        status: typeof item?.status === 'string' ? item.status : 'unknown',
        rateMultiplier: typeof item?.rateMultiplier === 'number' && Number.isFinite(item.rateMultiplier)
          ? item.rateMultiplier
          : null,
        vendor: typeof item?.vendor === 'string' && item.vendor.trim()
          ? item.vendor.trim().toLowerCase()
          : null,
      }))
      .filter((item: TokenGroupDetail) => item.name.length > 0)
    : []
);

const findGroupDetail = (catalog: TokenGroupDetail[], value: string): TokenGroupDetail | undefined => {
  const key = String(value || '').trim();
  if (!key) return undefined;
  return catalog.find((item) => (item.id || item.name) === key) || catalog.find((item) => item.name === key);
};

const formatGroupRate = (value: number): string => (
  Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)))
);

/**
 * A multiplier is provider-owned data: the user cannot know when upstream
 * repriced a group, so the cell shows when the value was read instead of
 * pretending it is live. Past this age it is flagged as possibly stale.
 */
const GROUP_RATE_STALE_MS = 10 * 60 * 1000;

const formatGroupRateFetchedAt = (value: unknown): string | null => {
  const ms = typeof value === 'number' ? value : (typeof value === 'string' ? Date.parse(value) : Number.NaN);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const buildGroupOptionLabel = (detail: TokenGroupDetail | undefined, fallback: string): string => {
  if (!detail) return fallback;
  const parts = [detail.name];
  if (detail.vendor) parts.push(detail.vendor);
  if (typeof detail.rateMultiplier === 'number') parts.push(`×${formatGroupRate(detail.rateMultiplier)}`);
  if (detail.status === 'inactive') parts.push(tr('不可用'));
  return parts.join(' · ');
};

/** Plain-text group description for the mobile card (no badges there). */
const formatTokenGroupText = (token: any): string => {
  const key = String(token?.tokenGroup || '').trim();
  const name = String(token?.groupName || (key ? `#${key}` : 'default'));
  const status = String(token?.groupStatus || '');
  const rate = typeof token?.groupRateMultiplier === 'number' ? token.groupRateMultiplier : null;
  const vendor = typeof token?.groupVendor === 'string' && token.groupVendor ? token.groupVendor : null;
  const parts = [name];
  if (vendor) parts.push(vendor);
  if (rate != null) parts.push(`×${formatGroupRate(rate)}`);
  if (status === 'inactive') parts.push(tr('不可用'));
  if (status === 'removed') parts.push(tr('已删除'));
  if (!token?.groupName && token?.groupCatalogError) parts.push(tr('分组表读取失败'));
  return parts.join(' · ');
};

/**
 * Table cell: group name + multiplier badge + availability warning.
 *
 * The name is single-line and ellipsised: upstream group names are long and
 * used to wrap into a second line with the multiplier badge stranded below it,
 * which made every row height jump. The full name (plus the raw key) stays in
 * the tooltip.
 *
 * `groupStatus === 'removed'` means upstream's group list no longer contains the
 * stored key — the group was deleted or taken offline, so the token's own state
 * says nothing about whether it can still serve traffic.
 */
function TokenGroupCell({ token, now }: { token: any; now?: number }) {
  const key = String(token?.tokenGroup || '').trim();
  // groupName is null when upstream did not return the key in its catalog; show
  // the raw id so a stale group is obvious rather than silently renamed.
  const name = String(token?.groupName || (key ? `#${key}` : 'default'));
  const status = String(token?.groupStatus || '');
  const rate = typeof token?.groupRateMultiplier === 'number' ? token.groupRateMultiplier : null;
  // Model vendor the group serves (sub2api publishes it as `platform`). Absent on
  // new-api, where the group endpoints carry no vendor at all.
  const vendor = typeof token?.groupVendor === 'string' && token.groupVendor ? token.groupVendor : null;
  const fetchedAtMs = typeof token?.groupFetchedAt === 'number' ? token.groupFetchedAt : null;
  const fetchedLabel = formatGroupRateFetchedAt(token?.groupFetchedAt);
  const nowMs = typeof now === 'number' ? now : Date.now();
  const rateStale = fetchedAtMs !== null && nowMs - fetchedAtMs > GROUP_RATE_STALE_MS;
  // Nothing resolved *and* the read itself failed: say so instead of letting the
  // bare "#key" look like a group upstream simply stopped publishing.
  const catalogError = typeof token?.groupCatalogError === 'string' && token.groupCatalogError
    ? token.groupCatalogError
    : null;
  const tooltipParts = [key && key !== name ? `${name}（${key}）` : name];
  if (vendor) tooltipParts.push(`${tr('厂商')}：${vendor}`);
  if (fetchedLabel) tooltipParts.push(`${tr('倍率更新于')} ${fetchedLabel}`);
  if (rateStale) tooltipParts.push(tr('分组倍率可能已过期，可点“刷新分组倍率”'));
  if (catalogError) tooltipParts.push(`${tr('读取上游分组表失败')}：${catalogError}`);
  const tooltip = tooltipParts.join(' · ');
  return (
    <span className="token-group-cell">
      <span className="token-group-name" title={tooltip}>{name}</span>
      {vendor ? (
        <span className="token-group-vendor" title={`${tr('厂商')}：${vendor}`}>{vendor}</span>
      ) : null}
      {rate != null ? (
        <span
          className={`token-group-rate${rateStale ? ' is-stale' : ''}`}
          title={rateStale
            ? tr('分组倍率可能已过期，可点“刷新分组倍率”')
            : (fetchedLabel ? `${tr('倍率更新于')} ${fetchedLabel}` : tr('分组倍率'))}
        >{`×${formatGroupRate(rate)}`}</span>
      ) : null}
      {status === 'inactive' ? (
        <span className="token-group-status">
          <StatusPill tone="warning" style={{ fontSize: 10 }}>{tr('不可用')}</StatusPill>
        </span>
      ) : null}
      {status === 'removed' ? (
        <span className="token-group-status" title={tr('上游分组列表中已没有该分组（已删除或已下架）')}>
          <StatusPill tone="danger" style={{ fontSize: 10 }}>{tr('已删除')}</StatusPill>
        </span>
      ) : null}
      {catalogError ? (
        <span className="token-group-status" title={`${tr('读取上游分组表失败')}：${catalogError}`}>
          <StatusPill tone="warning" style={{ fontSize: 10 }}>{tr('分组表读取失败')}</StatusPill>
        </span>
      ) : null}
    </span>
  );
}

const isMaskedPendingSyncResult = (result: AccountTokenSyncResult | null | undefined) =>
  String(result?.reason || '').trim().toLowerCase() === 'upstream_masked_tokens'
  && Number(result?.maskedPending || 0) > 0;

const resolveAccountLabel = (result: AccountTokenSyncResult | null | undefined) => {
  const name = typeof result?.accountName === 'string' ? result.accountName.trim() : '';
  if (name) return name;
  const username = typeof result?.account?.username === 'string' ? result.account.username.trim() : '';
  if (username) return username;
  const accountId = result?.accountId ?? result?.account?.id;
  if (accountId) return `#${accountId}`;
  return tr('未知账号');
};

export function TokensPanel({ embedded = false, onEmbeddedActionsChange, siteId: filterSiteId }: TokensPanelProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const initialCreateForm = {
    accountId: 0,
    name: '',
    group: 'default',
    unlimitedQuota: true,
    remainQuota: '',
    expiredTime: '',
    allowIps: '',
  };

  const [tokens, setTokens] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [syncingAccountId, setSyncingAccountId] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const [refreshingGroups, setRefreshingGroups] = useState(false);
  /**
   * Clock used only to re-evaluate how old a rendered multiplier is. The page may
   * stay open long after its catalog was read; without a tick the "possibly
   * stale" marker would never appear. This costs no network request.
   */
  const [rateAgeNow, setRateAgeNow] = useState(() => Date.now());
  const [saving, setSaving] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editingToken, setEditingToken] = useState<any | null>(null);
  const [editingTokenValueLoading, setEditingTokenValueLoading] = useState(false);
  const [editingTokenPendingMessage, setEditingTokenPendingMessage] = useState('');
  const [createHintModelName, setCreateHintModelName] = useState('');
  const [highlightTokenId, setHighlightTokenId] = useState<number | null>(null);
  const [pendingAutoOpenTokenId, setPendingAutoOpenTokenId] = useState<number | null>(null);
  const [rowLoading, setRowLoading] = useState<Record<string, boolean>>({});
  const [expandedTokenIds, setExpandedTokenIds] = useState<number[]>([]);
  const [showMobileTools, setShowMobileTools] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<null | {
    mode: 'single';
    tokenId?: number;
    tokenName?: string;
  }>(null);
  const [form, setForm] = useState(initialCreateForm);
  const [editForm, setEditForm] = useState({
    name: '',
    token: '',
    group: 'default',
    enabled: true,
    isDefault: false,
  });
  const [groupOptions, setGroupOptions] = useState<string[]>(['default']);
  const [groupCatalog, setGroupCatalog] = useState<TokenGroupDetail[]>([]);
  const [groupLoading, setGroupLoading] = useState(false);
  const [editGroupOptions, setEditGroupOptions] = useState<string[]>(['default']);
  const [editGroupCatalog, setEditGroupCatalog] = useState<TokenGroupDetail[]>([]);
  const [editGroupLoading, setEditGroupLoading] = useState(false);
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());
  const tokensTableRef = useRef<HTMLTableElement | null>(null);
  const tokensMobileListRef = useRef<HTMLDivElement | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editingTokenIdRef = useRef<number | null>(null);
  const toast = useToast();

  const load = useCallback(async (options?: { forceSnapshot?: boolean; refreshGroups?: boolean }) => {
    setLoading(true);
    try {
      const [tokenRows, accountSnapshot] = await Promise.all([
        api.getAccountTokens(undefined, options?.refreshGroups ? { refreshGroups: true } : undefined),
        api.getAccountsSnapshot(options?.forceSnapshot ? { refresh: true } : undefined),
      ]);
      const latestAccounts: SyncableAccount[] = Array.isArray(accountSnapshot?.accounts)
        ? accountSnapshot.accounts
        : [];
      const siteFilteredAccounts = filterSiteId
        ? latestAccounts.filter(
            (a: any) => a.siteId === filterSiteId || a.site?.id === filterSiteId,
          )
        : latestAccounts;
      const siteFilteredTokens = filterSiteId
        ? (tokenRows || []).filter((t: any) => {
            const acct = latestAccounts.find((a: any) => a.id === t.accountId);
            return acct && (acct.siteId === filterSiteId || acct.site?.id === filterSiteId);
          })
        : tokenRows || [];
      setTokens(siteFilteredTokens);
      setAccounts(siteFilteredAccounts);

      const syncableAccounts = siteFilteredAccounts.filter(isAccountSyncable);
      const hasCurrentSelected = syncableAccounts.some((account: SyncableAccount) => account.id === syncingAccountId);
      if (!hasCurrentSelected) {
        setSyncingAccountId(syncableAccounts[0]?.id || 0);
      }
      return {
        tokens: siteFilteredTokens,
        accounts: siteFilteredAccounts,
      };
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || tr('加载令牌失败'));
      return {
        tokens: [] as any[],
        accounts: [] as any[],
      };
    } finally {
      setLoading(false);
    }
  }, [syncingAccountId, toast, filterSiteId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setRateAgeNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!showAdd || !form.accountId) {
      setGroupLoading(false);
      setGroupOptions(['default']);
      return;
    }

    let cancelled = false;
    setGroupLoading(true);
    api.getAccountTokenGroups(form.accountId)
      .then((res: any) => {
        if (cancelled) return;
        const groups: string[] = Array.isArray(res?.groups)
          ? res.groups.map((item: any) => String(item || '').trim()).filter(Boolean)
          : [];
        const normalized = Array.from(new Set(groups));
        const nextOptions = normalized.length > 0 ? normalized : ['default'];
        setGroupOptions(nextOptions);
        setGroupCatalog(parseGroupDetails(res));
        setForm((prev) => {
          if (nextOptions.includes(prev.group)) return prev;
          return { ...prev, group: nextOptions[0] };
        });
      })
      .catch((error: any) => {
        if (cancelled) return;
        setGroupOptions(['default']);
        setGroupCatalog([]);
        setForm((prev) => ({ ...prev, group: 'default' }));
        toast.error(error?.message || tr('拉取分组失败，已回退 default'));
      })
      .finally(() => {
        if (cancelled) return;
        setGroupLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [showAdd, form.accountId]);

  useEffect(() => {
    if (!editingToken?.id || !editingToken?.accountId) {
      setEditGroupLoading(false);
      setEditGroupOptions(['default']);
      return;
    }

    const currentGroup = (editingToken?.tokenGroup || '').trim() || 'default';
    let cancelled = false;
    setEditGroupLoading(true);
    api.getAccountTokenGroups(editingToken.accountId)
      .then((res: any) => {
        if (cancelled) return;
        const groups = Array.isArray(res?.groups)
          ? res.groups.map((item: any) => String(item || '').trim()).filter(Boolean)
          : [];
        const normalized = Array.from(new Set(groups));
        setEditGroupCatalog(parseGroupDetails(res));
        setEditGroupOptions((_current) => {
          const next = normalized.length > 0 ? normalized : ['default'];
          if (next.includes(currentGroup)) return next;
          return [...next, currentGroup];
        });
      })
      .catch((error: any) => {
        if (cancelled) return;
        setEditGroupCatalog([]);
        setEditGroupOptions((current) => (current.includes(currentGroup) ? current : [...current, currentGroup]));
        toast.error(error?.message || tr('拉取分组失败，已保留当前分组'));
      })
      .finally(() => {
        if (cancelled) return;
        setEditGroupLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [editingToken?.id, editingToken?.accountId]);

  const accountClusteredTokens = useMemo(() => {
    const accountLabel = (token: any) => String(token?.account?.username || `account-${token?.accountId || 0}`).toLowerCase();
    const siteLabel = (token: any) => String(token?.site?.name || '').toLowerCase();
    const tokenName = (token: any) => String(token?.name || '').toLowerCase();

    return [...tokens].sort((left, right) => {
      const accountCmp = accountLabel(left).localeCompare(accountLabel(right));
      if (accountCmp !== 0) return accountCmp;
      const siteCmp = siteLabel(left).localeCompare(siteLabel(right));
      if (siteCmp !== 0) return siteCmp;
      const nameCmp = tokenName(left).localeCompare(tokenName(right));
      if (nameCmp !== 0) return nameCmp;
      return Number(left?.id || 0) - Number(right?.id || 0);
    });
  }, [tokens]);
  const [exactPageSize, setExactPageSize] = usePersistedPageSize('tokens');
  const {
    page: safePage,
    setPage,
    totalPages,
    pageSize,
    pagedItems: pagedTokens,
    showControls: showTokenPagination,
  } = useClientPagination(accountClusteredTokens, tokens.length, exactPageSize);

  const activeAccounts = useMemo(() => accounts.filter(isAccountSyncable), [accounts]);
  const activeAccountSelectOptions = useMemo(() => (
    activeAccounts.map((account) => {
      const accountName = account.username || `account-${account.id}`;
      const siteName = account.site?.name || '-';
      return {
        value: String(account.id),
        label: `${accountName} @ ${siteName}`,
        description: siteName,
      };
    })
  ), [activeAccounts]);

  /** Accounts offered when creating a token (session credential, site enabled). */
  const sessionAccounts = useMemo(() => accounts.filter(isSessionTokenAccount), [accounts]);
  const sessionAccountSelectOptions = useMemo(() => (
    sessionAccounts.map((account) => {
      const accountName = account.username || `account-${account.id}`;
      const siteName = account.site?.name || '-';
      return {
        value: String(account.id),
        label: `${accountName} @ ${siteName}${accountStatusSuffix(account)}`,
        description: siteName,
      };
    })
  ), [sessionAccounts]);
  const selectedCreateAccount = useMemo(
    () => sessionAccounts.find((account) => account.id === form.accountId) || null,
    [form.accountId, sessionAccounts],
  );

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const shouldOpenCreate = isTruthyFlag(params.get('create'));
    const requestedAccountId = parsePositiveInt(params.get('accountId'));
    const requestedModel = (params.get('model') || '').trim();
    if (!shouldOpenCreate || !requestedAccountId) return;

    const preferredAccount = sessionAccounts.find((account) => account.id === requestedAccountId)
      || activeAccounts.find((account) => account.id === requestedAccountId);
    const fallbackAccount = preferredAccount || activeAccounts[0] || sessionAccounts[0] || null;
    if (!fallbackAccount) return;

    setShowAdd(true);
    setCreateHintModelName(requestedModel);
    setSyncingAccountId(fallbackAccount.id);
    setForm((prev) => ({
      ...prev,
      accountId: fallbackAccount.id,
      group: 'default',
    }));

    if (!preferredAccount) {
      toast.info(tr('指定账号不可用，已自动切换到首个可用账号'));
    }

    params.delete('create');
    params.delete('accountId');
    params.delete('model');
    params.delete('from');
    const nextSearch = params.toString();
    navigate(
      {
        pathname: location.pathname,
        search: nextSearch ? `?${nextSearch}` : '',
      },
      { replace: true },
    );
  }, [activeAccounts, sessionAccounts, location.pathname, location.search, navigate, toast]);

  useEffect(() => {
    const focusTokenId = readFocusTokenId(location.search);
    if (!focusTokenId || loading) return;

    const cleanedSearch = clearFocusParams(location.search);
    const targetIndex = accountClusteredTokens.findIndex((token) => token.id === focusTokenId);
    if (targetIndex < 0) {
      navigate({ pathname: location.pathname, search: cleanedSearch }, { replace: true });
      return;
    }
    const targetPage = pageForItemIndex(targetIndex, pageSize);
    if (targetPage !== safePage) {
      setPage(targetPage);
      return;
    }

    const row = rowRefs.current.get(focusTokenId);
    if (!row) return;

    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightTokenId(focusTokenId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightTokenId((current) => (current === focusTokenId ? null : current));
    }, 2200);

    navigate({ pathname: location.pathname, search: cleanedSearch }, { replace: true });
  }, [accountClusteredTokens, loading, location.pathname, location.search, navigate, pageSize, safePage]);

  const focusTokenRow = useCallback((tokenId: number) => {
    const row = rowRefs.current.get(tokenId);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setHighlightTokenId(tokenId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightTokenId((current) => (current === tokenId ? null : current));
    }, 2200);
  }, []);

  const withRowLoading = async (key: string, fn: () => Promise<void>) => {
    setRowLoading((prev) => ({ ...prev, [key]: true }));
    try {
      await fn();
    } finally {
      setRowLoading((prev) => ({ ...prev, [key]: false }));
    }
  };

  const toggleTokenDetails = (tokenId: number) => {
    setExpandedTokenIds((current) => (
      current.includes(tokenId)
        ? current.filter((id) => id !== tokenId)
        : [...current, tokenId]
    ));
  };

  const confirmDelete = async () => {
    const target = deleteConfirm;
    if (!target?.tokenId) return;

    setDeleteConfirm(null);
    await withRowLoading(`token-${target.tokenId}-delete`, async () => {
      try {
        await api.deleteAccountToken(target.tokenId!);
        toast.success(tr('令牌已删除'));
        await load();
      } catch (error) {
        // The site could not confirm that the token is gone; the local row is
        // kept on purpose, so surface the server's reason instead of silence.
        toast.error(error instanceof Error ? error.message : tr('删除失败'));
      }
    });
  };

  const openEditPanel = useCallback((token: any) => {
    setShowAdd(false);
    setCreateHintModelName('');
    setEditingToken(token);
    editingTokenIdRef.current = token.id;
    setEditingTokenPendingMessage(
      isMaskedPendingToken(token)
        ? tr('请粘贴完整明文 token；当前本地仅保存了上游返回的脱敏占位值。')
        : '',
    );
    setEditForm({
      name: token?.name || '',
      token: '',
      group: (token?.tokenGroup || '').trim() || 'default',
      enabled: isMaskedPendingToken(token) ? true : token?.enabled !== false,
      isDefault: !!token?.isDefault,
    });

    if (isMaskedPendingToken(token)) {
      setEditingTokenValueLoading(false);
      return;
    }

    setEditingTokenValueLoading(true);

    void api.getAccountTokenValue(token.id)
      .then((res: any) => {
        if (editingTokenIdRef.current !== token.id) return;
        setEditForm((prev) => ({
          ...prev,
          token: typeof res?.token === 'string' ? res.token : prev.token,
        }));
      })
      .catch((error: any) => {
        if (editingTokenIdRef.current !== token.id) return;
        toast.error(error?.message || tr('加载令牌详情失败'));
      })
      .finally(() => {
        if (editingTokenIdRef.current !== token.id) return;
        setEditingTokenValueLoading(false);
      });
  }, [toast]);

  const closeEditPanel = useCallback(() => {
    editingTokenIdRef.current = null;
    setEditingToken(null);
    setSavingEdit(false);
    setEditingTokenValueLoading(false);
    setEditingTokenPendingMessage('');
    setEditForm({
      name: '',
      token: '',
      group: 'default',
      enabled: true,
      isDefault: false,
    });
  }, []);

  const saveEditPanel = async () => {
    if (!editingToken) return;
    if (isMaskedPendingToken(editingToken) && !editForm.token.trim()) {
      toast.error(tr('请粘贴完整明文 token 后再保存'));
      return;
    }
    setSavingEdit(true);
    try {
      await api.updateAccountToken(editingToken.id, {
        name: editForm.name.trim() || editingToken.name,
        token: editForm.token.trim() || undefined,
        group: editForm.group || 'default',
        enabled: editForm.enabled,
        isDefault: editForm.isDefault,
      });
      toast.success(tr('令牌已更新'));
      closeEditPanel();
      await load();
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || tr('更新令牌失败'));
    } finally {
      setSavingEdit(false);
    }
  };

  useEffect(() => {
    if (!pendingAutoOpenTokenId || loading) return;
    const token = tokens.find((item: any) => item.id === pendingAutoOpenTokenId);
    if (!token) return;
    focusTokenRow(token.id);
    openEditPanel(token);
    setPendingAutoOpenTokenId(null);
  }, [focusTokenRow, loading, openEditPanel, pendingAutoOpenTokenId, tokens]);

  const handleCopyToken = async (tokenId: number, tokenName: string) => {
    try {
      await withRowLoading(`token-${tokenId}-copy`, async () => {
        const res = await api.getAccountTokenValue(tokenId);
        const tokenValue = (res?.token || '').trim();
        if (!tokenValue) {
          toast.error(tr('令牌为空，无法复制'));
          return;
        }

        await copyText(tokenValue);
        toast.success(`已复制令牌：${tokenName || `token-${tokenId}`}`);
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast.error(errorMessage || tr('复制令牌失败'));
    }
  };

  const handleAddToken = async () => {
    if (!form.accountId) return;
    if (!form.unlimitedQuota) {
      const remainQuota = Number.parseInt(form.remainQuota, 10);
      if (!Number.isFinite(remainQuota) || remainQuota <= 0) {
        toast.error(tr('有限额度令牌请填写正整数额度'));
        return;
      }
    }
    setSaving(true);
    try {
      const remainQuota = form.unlimitedQuota
        ? undefined
        : Number.parseInt(form.remainQuota, 10);
      await api.addAccountToken({
        accountId: form.accountId,
        name: form.name,
        group: form.group || 'default',
        unlimitedQuota: form.unlimitedQuota,
        remainQuota,
        expiredTime: form.expiredTime || undefined,
        allowIps: form.allowIps,
      });
      toast.success(tr('已在站点创建并同步令牌'));
      setForm(initialCreateForm);
      setShowAdd(false);
      setCreateHintModelName('');
      await load();
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || tr('创建令牌失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleSync = useCallback(async () => {
    if (!syncingAccountId) return;
    setSyncing(true);
    try {
      const res = await api.syncAccountTokens(syncingAccountId) as AccountTokenSyncResult;
      const status = resolveSyncStatus(res);
      if (status === 'failed') {
        toast.error(`同步失败：${resolveSyncMessage(res, tr('请检查账号令牌或站点状态'))}`);
      } else if (isMaskedPendingSyncResult(res)) {
        toast.info(resolveSyncMessage(res, tr('上游返回了脱敏令牌，请补全明文 token')));
        const loaded = await load();
        const pendingIds = Array.isArray(res.pendingTokenIds)
          ? res.pendingTokenIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
          : [];
        const nextTokens = Array.isArray(loaded?.tokens) ? loaded.tokens : [];
        if (pendingIds.length === 1) {
          const pendingToken = nextTokens.find((token: any) => token.id === pendingIds[0]);
          if (pendingToken) {
            focusTokenRow(pendingToken.id);
            openEditPanel(pendingToken);
          } else {
            setPendingAutoOpenTokenId(pendingIds[0] || null);
          }
        } else if (pendingIds.length > 1) {
          focusTokenRow(pendingIds[0]!);
        }
        return;
      } else if (status === 'skipped') {
        toast.info(`同步已跳过：${resolveSyncMessage(res, tr('账号缺少可用 Session Cookie'))}`);
      } else {
        const coverage = res.coverageRefresh?.refresh?.[0];
        const modelCount = Number(coverage?.modelCount);
        const preview = Array.isArray(coverage?.modelsPreview)
          ? coverage!.modelsPreview!.filter(Boolean).slice(0, 4).join('、')
          : '';
        const groupFromSync = Array.isArray(res.tokens)
          ? (res.tokens.find((token) => token?.id)?.tokenGroup || res.tokens[0]?.tokenGroup || '')
          : '';
        const groupText = groupFromSync ? `；分组 ${groupFromSync}` : '';
        const coverageText = coverage?.refreshed
          ? (Number.isFinite(modelCount)
            ? `；模型已刷新 ${modelCount} 个${preview ? `（${preview}${modelCount > 4 ? '…' : ''}）` : ''}`
            : tr('；模型已刷新'))
          : (coverage?.errorMessage ? `；模型刷新失败：${coverage.errorMessage}` : '');
        toast.success(`同步完成：新增 ${res.created || 0}，更新 ${res.updated || 0}${groupText}${coverageText}`);
      }
      // Apply post-sync token rows immediately so group column updates before any follow-up GET.
      if (Array.isArray(res.tokens) && res.tokens.length > 0) {
        setTokens((prev: any[]) => {
          const byId = new Map(res.tokens!.map((token) => [Number(token?.id), token]));
          return prev.map((token: any) => {
            const patch = byId.get(Number(token?.id));
            if (!patch) return token;
            return {
              ...token,
              tokenGroup: patch.tokenGroup ?? token.tokenGroup,
              enabled: patch.enabled ?? token.enabled,
              isDefault: patch.isDefault ?? token.isDefault,
              valueStatus: patch.valueStatus ?? token.valueStatus,
              updatedAt: patch.updatedAt ?? token.updatedAt,
              name: patch.name ?? token.name,
            };
          });
        });
      }
      await load({ forceSnapshot: true });
      emitTokenCoverageChanged({
        accountIds: [syncingAccountId],
        source: 'account-token-sync',
      });
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || tr('同步令牌失败'));
    } finally {
      setSyncing(false);
    }
  }, [focusTokenRow, load, openEditPanel, syncingAccountId, toast]);

  const handleSyncAll = useCallback(async () => {
    setSyncingAll(true);
    try {
      const res = await api.syncAllAccountTokens();
      if (res?.queued) {
        toast.info(res.message || tr('已开始同步令牌，请稍后查看日志'));
        await load();
        return;
      }

      const syncResults = (
        Array.isArray(res?.results) ? res.results
          : Array.isArray(res?.items) ? res.items
            : Array.isArray(res?.accounts) ? res.accounts
              : []
      ) as AccountTokenSyncResult[];

      if (syncResults.length === 0) {
        const status = resolveSyncStatus(res as AccountTokenSyncResult);
        if (status === 'failed') {
          toast.error(`全部同步失败：${resolveSyncMessage(res, tr('请稍后重试'))}`);
        } else if (status === 'skipped') {
          toast.info(`全部同步已跳过：${resolveSyncMessage(res, tr('没有可同步的账号'))}`);
        } else {
          toast.success(tr('全部账号同步完成'));
        }
      } else {
        const failedRows = syncResults.filter((item) => resolveSyncStatus(item) === 'failed');
        const skippedRows = syncResults.filter((item) => resolveSyncStatus(item) === 'skipped');
        const successRows = syncResults.filter((item) => resolveSyncStatus(item) === 'success');
        const maskedRows = syncResults.filter((item) => isMaskedPendingSyncResult(item));

        toast.success(`全部同步完成：成功 ${successRows.length}，跳过 ${skippedRows.length}，失败 ${failedRows.length}`);

        failedRows.slice(0, 3).forEach((item) => {
          toast.error(`${resolveAccountLabel(item)} 同步失败：${resolveSyncMessage(item, tr('请检查账号配置'))}`);
        });
        maskedRows.slice(0, 3).forEach((item) => {
          toast.info(`${resolveAccountLabel(item)} 需要补全明文 token：${resolveSyncMessage(item, tr('上游返回脱敏令牌'))}`);
        });
        skippedRows.slice(0, 3).forEach((item) => {
          toast.info(`${resolveAccountLabel(item)} 已跳过：${resolveSyncMessage(item, tr('不满足同步条件'))}`);
        });

        if (failedRows.length > 3) {
          toast.error(`另有 ${failedRows.length - 3} 个失败账号，请查看日志`);
        }
        if (skippedRows.length > 3) {
          toast.info(`另有 ${skippedRows.length - 3} 个跳过账号，请查看日志`);
        }
      }

      await load({ forceSnapshot: true });
      emitTokenCoverageChanged({ source: 'account-token-sync-all' });
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || tr('全部同步失败'));
    } finally {
      setSyncingAll(false);
    }
  }, [load, toast]);

  /**
   * Multipliers change on the provider's schedule, not the user's, so the page
   * offers an explicit re-read instead of waiting out the server-side TTL.
   */
  const handleRefreshGroups = useCallback(async () => {
    setRefreshingGroups(true);
    try {
      const result = await load({ refreshGroups: true });
      // A forced re-read can fail upstream (expired session, WAF, credential
      // mode) and the list still renders fine, so the toast has to carry the
      // failure — otherwise "已刷新" was shown while nothing had been resolved.
      const failures = (result?.tokens ?? []).filter(
        (row: any) => !row?.groupName && typeof row?.groupCatalogError === 'string' && row.groupCatalogError,
      );
      if (failures.length > 0) {
        const first = String(failures[0].groupCatalogError);
        toast.error(`${tr('分组倍率刷新失败')}：${first}${failures.length > 1 ? `（${failures.length} 个账号）` : ''}`);
      } else {
        toast.success(tr('分组倍率已刷新'));
      }
    } finally {
      setRefreshingGroups(false);
    }
  }, [load, toast]);

  const handleSyncSite = useCallback(async () => {
    if (activeAccounts.length === 0) return;
    setSyncingAll(true);
    let success = 0, failed = 0;
    try {
      for (const account of activeAccounts) {
        try {
          await api.syncAccountTokens(account.id);
          success++;
        } catch {
          failed++;
        }
      }
      await load({ forceSnapshot: true });
      emitTokenCoverageChanged({ source: 'account-token-sync-site' });
      if (failed === 0) {
        toast.success(`站点令牌同步完成：成功 ${success}`);
      } else {
        toast.info(`站点令牌同步完成：成功 ${success}，失败 ${failed}`);
      }
    } catch (e) {
      const eMessage = e instanceof Error ? e.message : String(e);
      toast.error(eMessage || tr('同步站点令牌失败'));
    } finally {
      setSyncingAll(false);
    }
  }, [activeAccounts, load, toast]);

  const handleToggleAdd = useCallback(() => {
    const nextOpen = !showAdd;
    setShowAdd(nextOpen);
    if (!nextOpen) {
      setCreateHintModelName('');
      return;
    }
    // Preselect an account: the group picker only loads once an account is
    // chosen, so an empty selection also left "分组" with nothing to pick.
    setForm((current) => {
      if (current.accountId) return current;
      const preferred = activeAccounts[0] || sessionAccounts[0];
      return preferred ? { ...current, accountId: preferred.id } : current;
    });
  }, [activeAccounts, sessionAccounts, showAdd]);

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 14px',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    outline: 'none',
    background: 'var(--color-bg-inset)',
    color: 'var(--color-text-primary)',
  };

  const sectionCardStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: 14,
    border: '1px solid var(--color-border-light)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--color-bg-card)',
  };

  const sectionLabelStyle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--color-text-secondary)',
    letterSpacing: '0.02em',
  };

  const toggleCardStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '12px 14px',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--color-bg-inset)',
    color: 'var(--color-text-primary)',
  };

  const headerActions = useMemo(() => (
    <div className={`page-actions ${embedded ? 'accounts-page-actions' : ''}`.trim()}>
      {isMobile ? (
        <>
          <button
            type="button"
            onClick={() => setShowMobileTools(true)}
            className="btn btn-ghost btn-outline"
          >
            {tr('同步与筛选')}
          </button>
        </>
      ) : embedded ? (
        <>
          <button
            onClick={handleSyncSite}
            disabled={syncingAll || activeAccounts.length === 0}
            title={activeAccounts.length === 0 ? tr('没有可用的会话账号（账号会话已过期或被禁用）') : undefined}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {syncingAll ? <><span className="spinner spinner-sm" /> {tr('同步中...')}</> : tr('同步站点令牌')}
          </button>
        </>
      ) : (
        <>
          <div
            style={{ minWidth: 220, position: 'relative', zIndex: 20 }}
            title={activeAccounts.length === 0 ? tr('没有可用的会话账号（账号会话已过期或被禁用）') : undefined}
          >
            <ModernSelect
              size="sm"
              value={String(syncingAccountId || 0)}
              onChange={(nextValue) => setSyncingAccountId(Number.parseInt(nextValue, 10) || 0)}
              options={[
                { value: '0', label: tr('选择账号后同步站点令牌') },
                ...activeAccountSelectOptions,
              ]}
              placeholder={tr('选择账号后同步站点令牌')}
              searchable
              searchPlaceholder={ACCOUNT_SELECT_SEARCH_PLACEHOLDER}
            />
          </div>
          <button
            onClick={handleSync}
            disabled={syncing || syncingAll || !syncingAccountId}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {syncing ? <><span className="spinner spinner-sm" /> {tr('同步中...')}</> : tr('同步站点令牌')}
          </button>
          <button
            onClick={handleSyncAll}
            disabled={syncing || syncingAll || activeAccounts.length === 0}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {syncingAll ? <><span className="spinner spinner-sm" /> {tr('同步中...')}</> : tr('同步全部账号')}
          </button>
        </>
      )}
      {/* Mobile keeps this inside the "同步与筛选" drawer instead of crowding the header. */}
      {isMobile ? null : (
        <button
          onClick={handleRefreshGroups}
          disabled={refreshingGroups}
          title={tr('重新读取上游分组名称与倍率（分组倍率由服务商设置，随时可能变化）')}
          className="btn btn-ghost"
          style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
        >
          {refreshingGroups ? <><span className="spinner spinner-sm" /> {tr('刷新中...')}</> : tr('刷新分组倍率')}
        </button>
      )}
      <button
        onClick={handleToggleAdd}
        className="btn btn-primary"
      >
        {showAdd ? tr('取消') : tr('+ 新增令牌')}
      </button>
    </div>
  ), [activeAccountSelectOptions, activeAccounts.length, embedded, handleRefreshGroups, handleSync, handleSyncAll, handleSyncSite, handleToggleAdd, isMobile, refreshingGroups, showAdd, syncing, syncingAccountId, syncingAll]);

  useEffect(() => {
    if (!embedded || !onEmbeddedActionsChange) return;
    onEmbeddedActionsChange(headerActions);
    return () => {
      onEmbeddedActionsChange(null);
    };
  }, [embedded, headerActions, onEmbeddedActionsChange]);

  return (
    <div className={embedded ? '' : 'animate-fade-in'}>
      {(!embedded || !onEmbeddedActionsChange) && (
        <div className="page-header">
          {!embedded ? <h2 className="page-title">{tr('账号令牌')}</h2> : <div />}
          {headerActions}
        </div>
      )}

      <ResponsiveFilterPanel
        isMobile={isMobile}
        mobileOpen={showMobileTools}
        onMobileClose={() => setShowMobileTools(false)}
        mobileTitle={tr('令牌同步与筛选')}
        mobileContent={(
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{tr('同步账号')}</div>
              <ModernSelect
                value={String(syncingAccountId || 0)}
                onChange={(nextValue) => setSyncingAccountId(Number.parseInt(nextValue, 10) || 0)}
                options={[
                  { value: '0', label: tr('选择账号后同步站点令牌') },
                  ...activeAccountSelectOptions,
                ]}
                placeholder={tr('选择账号后同步站点令牌')}
                searchable
                searchPlaceholder={ACCOUNT_SELECT_SEARCH_PLACEHOLDER}
              />
              {activeAccounts.length === 0 ? (
                <div className="info-tip">{tr('没有可用的会话账号（账号会话已过期或被禁用），无法同步站点令牌。')}</div>
              ) : null}
            </div>
            <button
              onClick={handleSync}
              disabled={syncing || syncingAll || !syncingAccountId}
              className="btn btn-ghost btn-outline"
            >
              {syncing ? <><span className="spinner spinner-sm" /> {tr('同步中...')}</> : tr('同步站点令牌')}
            </button>
            <button
              onClick={handleSyncAll}
              disabled={syncing || syncingAll || activeAccounts.length === 0}
              className="btn btn-ghost btn-outline"
            >
              {syncingAll ? <><span className="spinner spinner-sm" /> {tr('同步中...')}</> : tr('同步全部账号')}
            </button>
            <button
              onClick={handleRefreshGroups}
              disabled={refreshingGroups}
              className="btn btn-ghost btn-outline"
            >
              {refreshingGroups ? <><span className="spinner spinner-sm" /> {tr('刷新中...')}</> : tr('刷新分组倍率')}
            </button>
          </div>
        )}
      />

      <div className="info-tip" style={{ marginBottom: 12 }}>{tr('新增令牌会调用站点 API 创建新密钥，再自动同步到本地。支持设置分组、额度、过期时间和 IP 白名单；已存在密钥可直接用“同步站点令牌”读取。')}</div>

      <DeleteConfirmModal
        open={Boolean(deleteConfirm)}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={confirmDelete}
        title={tr('确认删除令牌')}
        confirmText={tr('确认删除')}
        loading={Boolean(deleteConfirm?.tokenId && rowLoading[`token-${deleteConfirm.tokenId}-delete`])}
        description={<>{tr('确定要删除令牌')} <strong>{deleteConfirm?.tokenName || `#${deleteConfirm?.tokenId}`}</strong> {tr('吗？')}</>}
      />

      <CenteredModal
        open={Boolean(editingToken)}
        onClose={closeEditPanel}
        title={tr('编辑令牌')}
        maxWidth={760}
        bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        footer={(
          <>
            <button onClick={closeEditPanel} className="btn btn-ghost">{tr('取消')}</button>
            <button onClick={saveEditPanel} disabled={savingEdit || editingTokenValueLoading} className="btn btn-primary">
              {savingEdit ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> {tr('保存中...')}</> : tr('保存修改')}
            </button>
          </>
        )}
      >
        {editingToken ? (
          <>
            <div
              style={{
                fontSize: 12,
                color: 'var(--color-text-secondary)',
                background: 'color-mix(in srgb, var(--color-primary) 8%, var(--color-bg))',
                border: '1px solid color-mix(in srgb, var(--color-primary) 18%, transparent)',
                borderRadius: 'var(--radius-sm)',
                padding: '8px 10px',
              }}
            >
              账号: {editingToken.account?.username || `account-${editingToken.accountId}`} @ {editingToken.site?.name || '-'}
            </div>
            {editingTokenPendingMessage ? (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--color-text-secondary)',
                  background: 'color-mix(in srgb, var(--color-warning) 12%, var(--color-bg))',
                  border: '1px solid color-mix(in srgb, var(--color-warning) 28%, transparent)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '8px 10px',
                }}
              >
                {editingTokenPendingMessage}
              </div>
            ) : null}
            <div style={sectionCardStyle}>
              <div style={sectionLabelStyle}>{tr('基本信息')}</div>
              <ResponsiveFormGrid>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>{tr('令牌名称')}</div>
                  <input
                    placeholder={tr('令牌名称')}
                    value={editForm.name}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>{tr('分组')}</div>
                  <ModernSelect
                    value={editForm.group || 'default'}
                    onChange={(nextValue) => setEditForm((prev) => ({ ...prev, group: nextValue || 'default' }))}
                    options={(editGroupOptions.length > 0 ? editGroupOptions : ['default']).map((group) => ({
                      value: group,
                      label: buildGroupOptionLabel(findGroupDetail(editGroupCatalog, group), group),
                    }))}
                    placeholder={editGroupLoading ? tr('分组加载中...') : tr('选择分组')}
                    disabled={editGroupLoading}
                  />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>{tr('令牌值')}</div>
                  <textarea
                    placeholder={editingTokenValueLoading ? tr('令牌加载中...') : tr('令牌值')}
                    value={editForm.token}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, token: e.target.value }))}
                    style={{
                      ...inputStyle,
                      minHeight: 96,
                      resize: 'vertical',
                      fontFamily: 'var(--font-mono)',
                      lineHeight: 1.5,
                    }}
                    disabled={editingTokenValueLoading}
                  />
                </div>
              </ResponsiveFormGrid>
            </div>
            <div style={sectionCardStyle}>
              <div style={sectionLabelStyle}>{tr('状态设置')}</div>
              <ResponsiveFormGrid>
                <label style={toggleCardStyle}>
                  <input
                    type="checkbox"
                    checked={editForm.enabled}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, enabled: e.target.checked }))}
                    style={{ marginTop: 2 }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{tr('启用令牌')}</span>
                    <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{tr('关闭后令牌不会参与分发')}</span>
                  </div>
                </label>
                <label style={toggleCardStyle}>
                  <input
                    type="checkbox"
                    checked={editForm.isDefault}
                    onChange={(e) => setEditForm((prev) => ({ ...prev, isDefault: e.target.checked }))}
                    style={{ marginTop: 2 }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{tr('设为默认令牌')}</span>
                    <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{tr('优先作为该账号的默认转发令牌')}</span>
                  </div>
                </label>
              </ResponsiveFormGrid>
            </div>
          </>
        ) : null}
      </CenteredModal>

      <CenteredModal
        open={showAdd}
        onClose={handleToggleAdd}
        title={tr('新增令牌')}
        maxWidth={820}
        bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <ResponsiveFormGrid>
          <div style={{ gridColumn: '1 / -1' }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>{tr('所属账号')}</div>
            <ModernSelect
              value={String(form.accountId || 0)}
              onChange={(nextValue) => {
                setForm((prev) => ({
                  ...prev,
                  accountId: Number.parseInt(nextValue, 10) || 0,
                  group: '',
                }));
              }}
              options={[
                { value: '0', label: tr('选择账号') },
                ...sessionAccountSelectOptions,
              ]}
              placeholder={tr('选择账号')}
              searchable
              searchPlaceholder={ACCOUNT_SELECT_SEARCH_PLACEHOLDER}
            />
            {sessionAccounts.length === 0 ? (
              <div className="info-tip" style={{ marginTop: 8 }}>
                {tr('该站点下没有可用的会话账号：请先在「账号管理」添加账号或重新登录，再创建令牌。')}
              </div>
            ) : selectedCreateAccount
              && String(selectedCreateAccount.status || '').trim().toLowerCase() !== 'active' ? (
                <div className="info-tip" style={{ marginTop: 8, color: 'var(--color-warning)' }}>
                  {tr('该账号会话已过期：仍可用现有访问令牌创建，但失败时请先在账号管理重新登录。')}
                </div>
              ) : null}
          </div>
          {createHintModelName ? (
            <div
              style={{
                gridColumn: '1 / -1',
                fontSize: 12,
                color: 'var(--color-text-secondary)',
                background: 'color-mix(in srgb, var(--color-info) 10%, var(--color-bg))',
                border: '1px solid color-mix(in srgb, var(--color-info) 30%, transparent)',
                borderRadius: 'var(--radius-sm)',
                padding: '6px 8px',
              }}
            >{tr('来自路由提醒：为模型')} <code style={{ fontSize: 11 }}>{createHintModelName}</code> {tr('补充该账号令牌后，可自动生成对应通道。')}</div>
          ) : null}
          <div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>{tr('令牌名称（可选）')}</div>
            <input
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder={tr('例如 metapi')}
              style={inputStyle}
            />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>{tr('分组')}</div>
            <ModernSelect
              value={form.group || ''}
              onChange={(nextValue) => setForm((prev) => ({ ...prev, group: nextValue }))}
              options={(groupOptions.length > 0 ? groupOptions : ['default']).map((group) => ({
                value: group,
                label: buildGroupOptionLabel(findGroupDetail(groupCatalog, group), group),
              }))}
              placeholder={groupLoading ? tr('分组加载中...') : tr('选择分组')}
              disabled={!form.accountId || groupLoading}
            />
          </div>
          <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--color-text-secondary)' }}>
              <input
                type="checkbox"
                checked={form.unlimitedQuota}
                onChange={(e) => setForm((prev) => ({ ...prev, unlimitedQuota: e.target.checked }))}
              />{tr('不限额度')}</label>
            {!form.unlimitedQuota && (
              <input
                value={form.remainQuota}
                onChange={(e) => setForm((prev) => ({ ...prev, remainQuota: e.target.value.replace(/[^\d]/g, '') }))}
                placeholder={tr('额度（正整数）')}
                style={{ ...inputStyle, maxWidth: 220 }}
              />
            )}
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>{tr('过期时间（可选）')}</div>
            <input
              type="datetime-local"
              value={form.expiredTime}
              onChange={(e) => setForm((prev) => ({ ...prev, expiredTime: e.target.value }))}
              style={inputStyle}
            />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>{tr('IP 白名单（可选）')}</div>
            <input
              value={form.allowIps}
              onChange={(e) => setForm((prev) => ({ ...prev, allowIps: e.target.value }))}
              placeholder={tr('多个用英文逗号分隔')}
              style={inputStyle}
            />
          </div>
          <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', fontSize: 12, color: 'var(--color-text-muted)' }}>{tr('将在选中账号所属站点直接创建新密钥')}</div>
        </ResponsiveFormGrid>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 8 }}>
          <button onClick={handleToggleAdd} className="btn btn-ghost">{tr('取消')}</button>
          <button
            onClick={handleAddToken}
            disabled={saving || !form.accountId}
            className="btn btn-primary"
          >
            {saving ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> {tr('创建中...')}</> : tr('创建并同步令牌')}
          </button>
        </div>
      </CenteredModal>

      <div className="card" style={{ overflowX: 'auto', paddingBottom: 12 }}>
        {loading ? (
          <div style={{ padding: 20 }}>
            <div className="skeleton" style={{ width: '100%', height: 34, marginBottom: 8 }} />
            <div className="skeleton" style={{ width: '100%', height: 34, marginBottom: 8 }} />
            <div className="skeleton" style={{ width: '100%', height: 34 }} />
          </div>
        ) : tokens.length > 0 ? (
          isMobile ? (
            <div className="mobile-card-list" ref={tokensMobileListRef}>
              {pagedTokens.map((token: any) => {
                const loadingPrefix = `token-${token.id}`;
                const isPending = isMaskedPendingToken(token);
                const isExpanded = expandedTokenIds.includes(token.id);
                return (
                  <MobileCard
                    key={token.id}
                    title={token.name || '-'}
                    footerActions={(
                      <>
                        <button
                          type="button"
                          onClick={() => toggleTokenDetails(token.id)}
                          className="btn btn-link"
                        >
                          {isExpanded ? tr('收起') : tr('详情')}
                        </button>
                        {!isPending ? (
                          <button
                            onClick={() => handleCopyToken(token.id, token.name || '')}
                            disabled={!!rowLoading[`${loadingPrefix}-copy`]}
                            className="btn btn-link btn-link-primary"
                            data-testid={`token-copy-${token.id}`}
                          >
                            {rowLoading[`${loadingPrefix}-copy`] ? <span className="spinner spinner-sm" /> : tr('复制')}
                          </button>
                        ) : null}
                        <button
                          onClick={() => openEditPanel(token)}
                          className="btn btn-link btn-link-info"
                        >
                          {isPending ? tr('编辑补全') : tr('编辑')}
                        </button>
                      </>
                    )}
                  >
                    <MobileField label={tr('账号')} value={token.account?.username || `account-${token.accountId}`} />
                    <MobileField label={tr('分组')} value={formatTokenGroupText(token)} />
                    <MobileField
                      label={tr('状态')}
                      value={(
                        <StatusText badgeClass={isPending ? 'badge-warning' : (token.enabled ? 'badge-success' : 'badge-muted')} style={{ fontSize: 11 }}>
                          {isPending ? tr('待补全') : (token.enabled ? tr('启用') : tr('禁用'))}
                        </StatusText>
                      )}
                    />
                    {isExpanded ? (
                      <div className="mobile-card-extra">
                        <MobileField
                          label={tr('令牌值')}
                          stacked
                          value={<span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, wordBreak: 'break-all' }}>{token.tokenMasked || '***'}</span>}
                        />
                        <MobileField
                          label={tr('来源站点')}
                          value={token.site?.url ? (
                            <a
                              href={token.site.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="badge-link"
                            >
                              <span className="badge badge-muted" style={{ fontSize: 11 }}>
                                {token.site?.name || 'unknown'}
                              </span>
                            </a>
                          ) : (
                            <span className="badge badge-muted" style={{ fontSize: 11 }}>
                              {token.site?.name || 'unknown'}
                            </span>
                          )}
                        />
                        <MobileField
                          label={tr('默认')}
                          value={token.isDefault ? <StatusText tone="warning" style={{ fontSize: 11 }}>{tr('默认')}</StatusText> : '-'}
                        />
                        <MobileField label={tr('更新时间')} value={formatDateTimeLocal(token.updatedAt)} />
                        <div className="mobile-card-actions">
                          {!isPending && !token.isDefault && (
                            <button
                              onClick={() => withRowLoading(`${loadingPrefix}-default`, async () => {
                                await api.setDefaultAccountToken(token.id);
                                toast.success(tr('默认令牌已更新'));
                                await load();
                              })}
                              disabled={!!rowLoading[`${loadingPrefix}-default`]}
                              className="btn btn-link btn-link-info"
                            >
                              {rowLoading[`${loadingPrefix}-default`] ? <span className="spinner spinner-sm" /> : tr('设默认')}
                            </button>
                          )}
                          {!isPending ? (
                            <button
                              onClick={() => withRowLoading(`${loadingPrefix}-toggle`, async () => {
                                await api.updateAccountToken(token.id, { enabled: !token.enabled });
                                toast.success(token.enabled ? tr('令牌已禁用') : tr('令牌已启用'));
                                await load();
                              })}
                              disabled={!!rowLoading[`${loadingPrefix}-toggle`]}
                              className={`btn btn-link ${token.enabled ? 'btn-link-warning' : 'btn-link-primary'}`}
                            >
                              {rowLoading[`${loadingPrefix}-toggle`] ? <span className="spinner spinner-sm" /> : (token.enabled ? tr('禁用') : tr('启用'))}
                            </button>
                          ) : null}
                          <button
                            onClick={() => setDeleteConfirm({ mode: 'single', tokenId: token.id, tokenName: token.name || '' })}
                            disabled={!!rowLoading[`${loadingPrefix}-delete`]}
                            className="btn btn-link btn-link-danger"
                          >
                            {rowLoading[`${loadingPrefix}-delete`] ? <span className="spinner spinner-sm" /> : tr('删除')}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </MobileCard>
                );
              })}
            </div>
          ) : (
            <table className="data-table token-table" ref={tokensTableRef}>
            <thead>
              <tr>
                <th>{tr('令牌名称')}</th>
                <th>{tr('令牌值')}</th>
                <th>{tr('来源站点')}</th>
                <th>{tr('账号')}</th>
                <th>{tr('分组')}</th>
                <th>{tr('状态')}</th>
                <th>{tr('默认')}</th>
                <th>{tr('更新时间')}</th>
                <th className="token-table-actions-col">{tr('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {pagedTokens.map((token: any, i: number) => {
                const loadingPrefix = `token-${token.id}`;
                const isPending = isMaskedPendingToken(token);
                return (
                  <tr
                    key={token.id}
                    data-testid={`token-row-${token.id}`}
                    ref={(node) => {
                      if (node) rowRefs.current.set(token.id, node);
                      else rowRefs.current.delete(token.id);
                    }}
                    className={`animate-slide-up stagger-${Math.min(i + 1, 5)} ${highlightTokenId === token.id ? 'row-focus-highlight' : ''}`.trim()}
                  >
                    <td className="token-name-cell">
                      <span className="inventory-name-title" title={token.name || undefined}>
                        {token.name || '-'}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{token.tokenMasked || '***'}</td>
                    <td className="token-site-cell">
                      {token.site?.url ? (
                        <a
                          href={token.site.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="badge-link"
                          onClick={(e) => e.stopPropagation()}
                          title={token.site?.name || undefined}
                        >
                          <span className="badge badge-muted" style={{ fontSize: 11 }}>
                            {token.site?.name || 'unknown'}
                          </span>
                        </a>
                      ) : (
                        <span className="badge badge-muted" style={{ fontSize: 11 }} title={token.site?.name || undefined}>
                          {token.site?.name || 'unknown'}
                        </span>
                      )}
                    </td>
                    <td>{token.account?.username || `account-${token.accountId}`}</td>
                    <td><TokenGroupCell token={token} now={rateAgeNow} /></td>
                    <td>
                      {isPending ? (
                        <StatusPill tone="warning" style={{ fontSize: 11 }}>{tr('待补全')}</StatusPill>
                      ) : (
                        <StatusText badgeClass={token.enabled ? 'badge-success' : 'badge-muted'} style={{ fontSize: 11 }}>
                          {token.enabled ? tr('启用') : tr('禁用')}
                        </StatusText>
                      )}
                    </td>
                    <td>{token.isDefault ? <StatusText tone="warning" style={{ fontSize: 11 }}>{tr('默认')}</StatusText> : '-'}</td>
                    <td style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{formatDateTimeLocal(token.updatedAt)}</td>
                    <td className="token-actions-cell">
                      <div className="token-table-actions">
                        {!isPending && !token.isDefault && (
                          <button
                            onClick={() => withRowLoading(`${loadingPrefix}-default`, async () => {
                              await api.setDefaultAccountToken(token.id);
                              toast.success(tr('默认令牌已更新'));
                              await load();
                            })}
                            disabled={!!rowLoading[`${loadingPrefix}-default`]}
                            className="btn btn-link btn-link-info token-table-action-btn"
                          >
                            {rowLoading[`${loadingPrefix}-default`] ? <span className="spinner spinner-sm" /> : tr('设默认')}
                          </button>
                        )}
                        {!isPending ? (
                          <button
                            onClick={() => handleCopyToken(token.id, token.name || '')}
                            disabled={!!rowLoading[`${loadingPrefix}-copy`]}
                            className="btn btn-link btn-link-primary token-table-action-btn"
                            data-testid={`token-copy-${token.id}`}
                          >
                            {rowLoading[`${loadingPrefix}-copy`] ? <span className="spinner spinner-sm" /> : tr('复制')}
                          </button>
                        ) : null}
                        <button
                          onClick={() => openEditPanel(token)}
                          className="btn btn-link btn-link-info token-table-action-btn"
                        >
                          {isPending ? tr('编辑补全') : tr('编辑')}
                        </button>
                        {!isPending ? (
                          <button
                            onClick={() => withRowLoading(`${loadingPrefix}-toggle`, async () => {
                              await api.updateAccountToken(token.id, { enabled: !token.enabled });
                              toast.success(token.enabled ? tr('令牌已禁用') : tr('令牌已启用'));
                              await load();
                            })}
                            disabled={!!rowLoading[`${loadingPrefix}-toggle`]}
                            className={`btn btn-link ${token.enabled ? 'btn-link-warning' : 'btn-link-primary'} token-table-action-btn`}
                          >
                            {rowLoading[`${loadingPrefix}-toggle`] ? <span className="spinner spinner-sm" /> : (token.enabled ? tr('禁用') : tr('启用'))}
                          </button>
                        ) : null}
                        <button
                          onClick={() => setDeleteConfirm({ mode: 'single', tokenId: token.id, tokenName: token.name || '' })}
                          disabled={!!rowLoading[`${loadingPrefix}-delete`]}
                          className="btn btn-link btn-link-danger token-table-action-btn"
                        >
                          {rowLoading[`${loadingPrefix}-delete`] ? <span className="spinner spinner-sm" /> : tr('删除')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          )
        ) : (
          <div className="empty-state">
            <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>
            <div className="empty-state-title">{tr('暂无令牌')}</div>
            <div className="empty-state-desc">{tr('可先同步站点令牌，或直接在站点创建新令牌。')}</div>
          </div>
        )}
        {!loading ? (
          <PaginationControls
            page={safePage}
            totalPages={totalPages}
            onPageChange={setPage}
            visible={showTokenPagination}
            pageSize={exactPageSize}
            onPageSizeChange={setExactPageSize}
          />
        ) : null}
      </div>
    </div>
  );
}
