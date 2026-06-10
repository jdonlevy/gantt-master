import type { IPublicClientApplication } from '@azure/msal-browser';
import { getMsalScopes } from './msalBootstrap';

// Whitelist of route shapes the app actually renders (see <Routes> in App.tsx).
// Anything else — a deep link copied from elsewhere, a 404 path the user
// happened to be on, or an attacker-supplied `?redirect=` — falls back to `/`
// so MSAL's redirectStartPage can't bounce the user to a nonexistent page or
// be used for open-redirect abuse.
const SAFE_PATH_PATTERNS: RegExp[] = [
  /^\/$/,
  /^\/dashboards$/,
  /^\/dashboards\/[A-Za-z0-9_-]+$/,
  /^\/dashboards\/[A-Za-z0-9_-]+\/weekly-update$/,
  /^\/release-notes$/,
  /^\/release-notes\/[A-Za-z0-9._-]+$/,
  /^\/admin\/users$/,
];

export function sanitiseRedirectStartPage(href: string): string {
  try {
    const url = new URL(href, window.location.origin);
    // Reject cross-origin and non-http(s).
    if (url.origin !== window.location.origin) return `${window.location.origin}/`;
    const path = url.pathname;
    if (SAFE_PATH_PATTERNS.some((p) => p.test(path))) {
      return `${url.origin}${path}${url.search}`;
    }
    return `${url.origin}/`;
  } catch {
    return `${window.location.origin}/`;
  }
}

export function performLoginRedirect(instance: IPublicClientApplication): Promise<void> {
  return instance.loginRedirect({
    scopes: getMsalScopes(),
    redirectStartPage: sanitiseRedirectStartPage(window.location.href),
  });
}

export function performLogoutRedirect(instance: IPublicClientApplication): Promise<void> {
  return instance.logoutRedirect({
    postLogoutRedirectUri: window.location.origin,
  });
}
