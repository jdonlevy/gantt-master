import {
  CustomBar,
  DashboardDetail,
  DashboardFilters,
  DashboardPanel,
  DashboardSummary,
  DependencyNodeType,
  FixVersion,
  MetricsResponse,
  Milestone,
  Project,
  RoadmapResponse,
  WeeklyUpdateResponse,
} from './types';

type Env = {
  VITE_API_BASE_URL?: string;
  VITE_AZURE_AD_CLIENT_ID?: string;
  VITE_AZURE_AD_TENANT_ID?: string;
  VITE_AZURE_AD_AUTHORITY?: string;
};
type EnvWindow = Window & { __ENV__?: Env };

export const getEnv = (): Env => (window as EnvWindow).__ENV__ ?? {};

export const getApiBase = () => getEnv().VITE_API_BASE_URL || '';

export const apiBase = getApiBase();

type TokenGetter = () => Promise<string | null>;
type ForbiddenHandler = (message: string) => void;
type AuthFailureHandler = () => void;

let _getToken: TokenGetter | null = null;
let _getTokenForceRefresh: TokenGetter | null = null;
let _onAuthFailure: AuthFailureHandler | null = null;
let forbiddenHandler: ForbiddenHandler | null = null;
// Last token actually fetched from the MSAL getter. Refreshed on every
// apiFetch call and exposed via getCachedAccessToken() for synchronous
// readers — primarily the beforeunload keepalive PUT, which can't await
// an async token acquisition during page tear-down.
let _cachedToken: string | null = null;

export const setTokenGetter = (fn: TokenGetter | null) => {
  _getToken = fn;
  if (fn === null) _cachedToken = null;
};
/** Read the current access token from the module-level getter. Returns null
 *  if no getter has been registered (e.g. unauthenticated session). Used by
 *  callers like useDashboardEvents that can't go through doFetch but still
 *  need to attach the Bearer token. */
export const getAccessToken = async (): Promise<string | null> => {
  const t = (await _getToken?.()) ?? null;
  if (t) _cachedToken = t;
  return t;
};
/** Synchronous read of the most recently acquired access token. Returns null
 *  if no apiFetch has run since login (i.e. no token has yet been cached).
 *  Use for cases where awaiting is impossible — currently the `beforeunload`
 *  keepalive PUT in WeeklyUpdatePanel, where the page is tearing down and
 *  an async token acquisition would be aborted by the browser. */
export const getCachedAccessToken = (): string | null => _cachedToken;
export const setTokenForceRefreshGetter = (fn: TokenGetter | null) => {
  _getTokenForceRefresh = fn;
};
export const setAuthFailureHandler = (fn: AuthFailureHandler | null) => {
  _onAuthFailure = fn;
};
export const setForbiddenHandler = (handler: ForbiddenHandler | null) => {
  forbiddenHandler = handler;
};

const doFetch = async (path: string, init: RequestInit, token: string | null) => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) || {})
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return fetch(`${apiBase}${path}`, {
    credentials: 'include',
    ...init,
    headers
  });
};

const apiFetch = async (path: string, init: RequestInit = {}) => {
  const token = (await _getToken?.()) ?? null;
  if (token) _cachedToken = token;
  let response = await doFetch(path, init, token);

  // Single 401 retry with a force-refreshed token. Mirrors the OATS pattern —
  // covers the case where MSAL has cached a soon-to-expire token that the
  // backend already rejected.
  if (response.status === 401) {
    if (_getTokenForceRefresh) {
      const fresh = await _getTokenForceRefresh().catch(() => null);
      if (fresh && fresh !== token) {
        _cachedToken = fresh;
        response = await doFetch(path, init, fresh);
      }
    } else {
      // No force-refresh getter registered (e.g. wiring not yet complete) —
      // skip the retry instead of crashing. Surface so we can diagnose.
      console.warn('apiFetch: 401 received but no force-refresh getter registered; skipping retry');
    }
  }

  if (!response.ok) {
    if (response.status === 401) {
      // Invalidate the cached token BEFORE triggering re-login. A fast
      // re-login cycle that reads getCachedAccessToken() (e.g. the
      // beforeunload keepalive) would otherwise replay the stale token.
      _cachedToken = null;
      if (_onAuthFailure) _onAuthFailure();
      throw new Error('Not authenticated');
    }
    const text = await response.text();
    if (response.status === 403 && forbiddenHandler) {
      // Surface "your role doesn't allow this" without nuking the session
      // (which is what 401 means). Caller still gets a thrown error so the
      // optimistic UI can roll back.
      forbiddenHandler(text || 'You do not have permission to perform this action.');
    }
    const error = new Error(text || response.statusText) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  // 204 No Content has no body; callers that return Promise<void> rely on this.
  if (response.status === 204) {
    return null;
  }
  return response.json();
};

export const fetchProjects = (): Promise<Project[]> => apiFetch('/api/projects');
export const fetchFixVersions = (
  projects: string[],
  incrementStart: string,
  incrementEnd: string
): Promise<FixVersion[]> => {
  const params = new URLSearchParams();
  projects.forEach((project) => params.append('projects[]', project));
  params.set('increment_start', incrementStart);
  params.set('increment_end', incrementEnd);
  return apiFetch(`/api/fix-versions?${params.toString()}`);
};

export const fetchComponents = (projects: string[]): Promise<{ id: string; name: string }[]> => {
  const params = new URLSearchParams();
  projects.forEach((project) => params.append('projects[]', project));
  return apiFetch(`/api/components?${params.toString()}`);
};

export const fetchRoadmap = (
  projects: string[],
  incrementStart: string,
  incrementEnd: string,
  fixVersions: string[],
  components: string[],
  dashboardId?: string | null,
  signal?: AbortSignal
): Promise<RoadmapResponse> => {
  const params = new URLSearchParams();
  projects.forEach((project) => params.append('projects[]', project));
  fixVersions.forEach((fixVersion) => params.append('fixVersions[]', fixVersion));
  components.forEach((component) => params.append('components[]', component));
  params.set('increment_start', incrementStart);
  params.set('increment_end', incrementEnd);
  if (dashboardId) {
    params.set('dashboard_id', dashboardId);
  }
  return apiFetch(`/api/roadmap?${params.toString()}`, signal ? { signal } : undefined);
};

export const updateFixVersionOverrides = async (payload: {
  fixVersionId: string;
  dashboardId?: string | null;
  uatStart?: string | null;
  uatEnd?: string | null;
  liveStart?: string | null;
  liveEnd?: string | null;
  notes?: string | null;
}): Promise<{
  id: string;
  uatStart?: string | null;
  uatEnd?: string | null;
  liveStart?: string | null;
  liveEnd?: string | null;
  notes?: string | null;
}> =>
  apiFetch('/api/overrides/fix-version', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

export type DependencyOverrideResponse = {
  id: string;
  fromId: string;
  toId: string;
  fromType: DependencyNodeType;
  toType: DependencyNodeType;
  dashboardId?: string | null;
};

export const createDependencyOverride = (payload: {
  fromId: string;
  toId: string;
  fromType: DependencyNodeType;
  toType: DependencyNodeType;
  dashboardId?: string | null;
}): Promise<DependencyOverrideResponse> =>
  apiFetch('/api/overrides/dependency', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

export const deleteDependencyOverride = async (overrideId: string): Promise<void> => {
  // Returns 204; apiFetch now handles that without throwing on empty body,
  // so we share its auth/error-handling path with every other write.
  await apiFetch(`/api/overrides/dependency/${overrideId}`, {
    method: 'DELETE'
  });
};

export const createMilestone = (payload: {
  label: string;
  date: string;
  color: string;
  projectScope?: string | null;
  showLabel?: boolean;
  dashboardId?: string | null;
}): Promise<Milestone> =>
  apiFetch('/api/milestones', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

export const deleteMilestone = (milestoneId: string): Promise<{ ok: true }> =>
  apiFetch(`/api/milestones/${milestoneId}`, {
    method: 'DELETE'
  });

export const updateMilestone = (milestoneId: string, payload: Partial<Milestone>): Promise<Milestone> =>
  apiFetch(`/api/milestones/${milestoneId}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });

export type UserRole = 'viewer' | 'editor' | 'admin';

export type CurrentUser = {
  id: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
};

export type SessionResponse = {
  authenticated: boolean;
  user?: CurrentUser | null;
  jiraLinked?: boolean;
};

export const fetchSession = (): Promise<SessionResponse> => apiFetch('/api/session');

export const unlinkJira = (): Promise<{ ok: true }> =>
  apiFetch('/api/jira/unlink', { method: 'POST' });

/** Start the Jira-link OAuth dance. Returns the URL the browser should navigate to. */
export const startJiraLink = (): Promise<{ auth_url: string }> =>
  apiFetch('/api/jira/link', { method: 'POST' });

export type AdminUser = {
  id: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
  lastSeenAt: string | null;
};

export const fetchAdminUsers = (): Promise<AdminUser[]> => apiFetch('/api/admin/users');

export const updateUserRole = (userId: string, role: UserRole): Promise<AdminUser> =>
  apiFetch(`/api/admin/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ role })
  });

export const fetchDashboards = (): Promise<DashboardSummary[]> => apiFetch('/api/dashboards');

export const createDashboard = (payload: {
  title: string;
  slug?: string;
  folder?: string | null;
  description?: string;
  filters?: DashboardFilters;
}): Promise<DashboardDetail> =>
  apiFetch('/api/dashboards', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

export const fetchDashboard = (slug: string): Promise<DashboardDetail> => apiFetch(`/api/dashboards/${slug}`);

export const fetchDashboardSnapshot = (slug: string): Promise<RoadmapResponse | null> =>
  apiFetch(`/api/dashboards/${slug}/snapshot`);

export const updateDashboard = (
  slug: string,
  payload: { title?: string; folder?: string | null; description?: string | null; filters?: DashboardFilters }
): Promise<DashboardDetail> =>
  apiFetch(`/api/dashboards/${slug}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });

export const duplicateDashboard = (slug: string): Promise<DashboardDetail> =>
  apiFetch(`/api/dashboards/${slug}/duplicate`, { method: 'POST' });

export const createCustomBar = (payload: {
  name: string;
  swimlaneId: string | null;
  start: string;
  end: string;
  color: string;
  showName: boolean;
  dashboardId: string;
}): Promise<CustomBar> =>
  apiFetch('/api/custom_bars', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

export const updateCustomBar = (barId: string, payload: Partial<Pick<CustomBar, 'name' | 'start' | 'end' | 'color' | 'showName'>>): Promise<CustomBar> =>
  apiFetch(`/api/custom_bars/${barId}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });

export const deleteCustomBar = (barId: string): Promise<{ ok: true }> =>
  apiFetch(`/api/custom_bars/${barId}`, { method: 'DELETE' });

export const updateDashboardSnapshot = (slug: string, payload: RoadmapResponse): Promise<RoadmapResponse> =>
  apiFetch(`/api/dashboards/${slug}/snapshot`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });

export const createDashboardPanel = (
  slug: string,
  payload: { type: string; title?: string; row: number; column: number; width: number; height: number }
): Promise<DashboardPanel> =>
  apiFetch(`/api/dashboards/${slug}/panels`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });

export const updateDashboardPanel = (
  slug: string,
  panelId: string,
  payload: { title?: string; row?: number; column?: number; width?: number; height?: number; collapsed?: boolean }
): Promise<DashboardPanel> =>
  apiFetch(`/api/dashboards/${slug}/panels/${panelId}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });

export const updateDashboardPanelContent = (
  slug: string,
  panelId: string,
  payload: { contentJson?: Record<string, unknown> | null; contentHtml?: string | null }
): Promise<DashboardPanel> =>
  apiFetch(`/api/dashboards/${slug}/panels/${panelId}/content`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });

export const deleteDashboardPanel = (slug: string, panelId: string): Promise<{ ok: true }> =>
  apiFetch(`/api/dashboards/${slug}/panels/${panelId}`, {
    method: 'DELETE'
  });

export const deleteDashboard = (slug: string): Promise<{ ok: true }> =>
  apiFetch(`/api/dashboards/${slug}`, {
    method: 'DELETE'
  });

export const generateWeeklyUpdate = (
  slug: string,
  fixVersions?: string[],
  conciseness?: number,
  releasedRange?: { from?: string; to?: string }
): Promise<WeeklyUpdateResponse> => {
  const body: Record<string, unknown> = {};
  if (fixVersions && fixVersions.length > 0) body.fixVersions = fixVersions;
  if (conciseness !== undefined) body.conciseness = conciseness;
  if (releasedRange?.from) body.releasedFrom = releasedRange.from;
  if (releasedRange?.to) body.releasedTo = releasedRange.to;
  const init: RequestInit = { method: 'POST' };
  if (Object.keys(body).length > 0) init.body = JSON.stringify(body);
  return apiFetch(`/api/dashboards/${slug}/generate-update`, init);
};

export const fetchMetrics = (
  projects: string[],
  statuses?: string[],
  days?: number,
  fixVersions?: string[]
): Promise<MetricsResponse> => {
  const params = new URLSearchParams();
  projects.forEach((p) => params.append('projects[]', p));
  (statuses ?? []).forEach((s) => params.append('statuses[]', s));
  (fixVersions ?? []).forEach((id) => params.append('fixVersions[]', id));
  if (days !== undefined) params.set('days', String(days));
  return apiFetch(`/api/metrics?${params.toString()}`);
};

export type PresenceUser = {
  accountId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

export type PresenceEntry = {
  accountId: string;
  displayName: string;
  avatarUrl: string | null;
  barId: string;
};

export const fetchMe = (): Promise<PresenceUser> => apiFetch('/api/me');

// Unique ID for this browser tab (not persisted — a new one is generated each
// page load). Used so that two tabs opened by the same user can see each
// other's presence indicators, since they share the same session cookie.
export const TAB_ID = Math.random().toString(36).slice(2);

export const setPresence = (slug: string, barId: string): Promise<{ ok: boolean }> =>
  apiFetch('/api/presence', {
    method: 'PUT',
    body: JSON.stringify({ slug, barId, tabId: TAB_ID }),
  });

export const clearPresence = (): Promise<{ ok: boolean }> =>
  apiFetch(`/api/presence?tabId=${encodeURIComponent(TAB_ID)}`, { method: 'DELETE' });

export const fetchPresence = (slug: string): Promise<PresenceEntry[]> =>
  apiFetch(`/api/presence/${encodeURIComponent(slug)}?tabId=${encodeURIComponent(TAB_ID)}`);

export const fetchPanelContent = (slug: string, panelId: string): Promise<{ contentJson: Record<string, unknown> | null; updatedAt: string | null }> =>
  apiFetch(`/api/dashboards/${encodeURIComponent(slug)}/panels/${encodeURIComponent(panelId)}/content`);
