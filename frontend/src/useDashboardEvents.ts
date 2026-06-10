import { useEffect, useRef, useState } from 'react';
import { apiBase, getAccessToken } from './api';

/**
 * Subscribe to a dashboard's server-sent event stream.
 *
 * Replaces the previous content-fetch polling loops. The backend emits an
 * event (e.g. `panel.updated`) whenever a panel mutates; this hook routes
 * each event to its handler. Browsers reconnect EventSource automatically
 * after transient network drops, but events emitted during a disconnect
 * are lost — pass `onOpen` to refetch dashboard state on reconnect if
 * exactness matters.
 *
 * Auth flows over the session cookie via `withCredentials`. The endpoint
 * gates on viewer role server-side.
 *
 * Handlers are read through a ref so callers can pass fresh closures on
 * each render without tearing down the EventSource.
 */
export type DashboardEventHandlers = {
  /** Called on initial connect AND on every reconnect after a drop. */
  onOpen?: () => void;
  /** A panel's content changed on the server. Refetch to apply. */
  onPanelUpdated?: (payload: { panelId: string; updatedAt: string | null }) => void;
  /** Called on EventSource errors (does not stop reconnection attempts). */
  onError?: (err: Event) => void;
};

/**
 * Coarse-grained connection state for the SSE stream. Consumers can use this
 * to surface a banner / dot when we permanently give up after the token-retry
 * budget is exhausted. Kept as an additive return value so existing call
 * sites that ignore it continue to work unchanged.
 *
 *   'connecting'  — initial mount or waiting for an MSAL token
 *   'connected'   — EventSource has opened
 *   'reconnecting'— transient error, browser is retrying
 *   'failed'      — gave up waiting for a token; the stream is dead
 */
export type DashboardEventsConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

export type UseDashboardEventsResult = {
  connectionState: DashboardEventsConnectionState;
};

export function useDashboardEvents(
  slug: string | undefined,
  handlers: DashboardEventHandlers,
): UseDashboardEventsResult {
  // Stash handlers in a ref so the EventSource isn't torn down every render
  // just because the parent re-rendered with a new closure.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  const [connectionState, setConnectionState] =
    useState<DashboardEventsConnectionState>('connecting');

  useEffect(() => {
    if (!slug) return;
    let es: EventSource | null = null;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    setConnectionState('connecting');

    // EventSource can't set request headers, so the Azure AD Bearer token is
    // appended as a `?token=` query param. The backend's SSE auth helper
    // accepts either the header or the query token.
    //
    // Token availability race: the dashboard page can mount before MSAL's
    // useEffect has registered the token getter via setTokenGetter (both
    // run in the same render cycle and React doesn't guarantee an order
    // between siblings). If the first call returns null we retry with a
    // short backoff — typical MSAL silent-token resolution is well under
    // a second on a warm cache.
    const connect = async (attempt = 0) => {
      if (cancelled) return;
      const token = await getAccessToken();
      if (cancelled) return;
      if (!token) {
        if (attempt >= 10) {
          // eslint-disable-next-line no-console
          console.warn('[sse] gave up waiting for access token after 10 retries');
          if (!cancelled) setConnectionState('failed');
          return;
        }
        retryTimer = setTimeout(() => connect(attempt + 1), 300);
        return;
      }
      const url = `${apiBase}/api/dashboards/${slug}/events?token=${encodeURIComponent(token)}`;
      es = new EventSource(url, { withCredentials: true });

      const onOpen = () => {
        if (!cancelled) setConnectionState('connected');
        handlersRef.current.onOpen?.();
      };
      const onError = (err: Event) => {
        // EventSource auto-reconnects after transient drops; surface that as
        // 'reconnecting' so the UI can show a subtle indicator instead of
        // pretending nothing's wrong. We don't flip to 'failed' here — the
        // browser keeps retrying — only the token-budget exhaustion above
        // is treated as terminal.
        if (!cancelled) setConnectionState('reconnecting');
        handlersRef.current.onError?.(err);
      };
      const onPanelUpdated = (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data) as { panelId: string; updatedAt: string | null };
          handlersRef.current.onPanelUpdated?.(payload);
        } catch {
          // Malformed event — ignore and let the connection continue.
        }
      };

      es.addEventListener('open', onOpen);
      es.addEventListener('error', onError);
      es.addEventListener('panel.updated', onPanelUpdated as EventListener);
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (es) es.close();
    };
  }, [slug]);

  return { connectionState };
}
