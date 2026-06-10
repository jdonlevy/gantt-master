import React, { useEffect, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import {
  apiBase,
  CurrentUser,
  fetchSession,
  setAuthFailureHandler,
  setForbiddenHandler,
  setTokenForceRefreshGetter,
  setTokenGetter,
  startJiraLink,
  unlinkJira,
} from './api';
import { AuthGuard } from './auth/AuthGuard';
import { performLoginRedirect, performLogoutRedirect } from './auth/authHelpers';
import { getMsalScopes } from './auth/msalBootstrap';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { DashboardList } from './pages/DashboardList';
import { DashboardPage } from './pages/DashboardPage';
import { ReleaseNotesList } from './pages/ReleaseNotesList';
import { ReleaseNotesPage } from './pages/ReleaseNotesPage';
import WeeklyUpdatePage from './pages/WeeklyUpdatePage';

const themeStorageKey = 'delivery-tracker:theme';

const readStorage = (key: string, fallback: string) => {
  // localStorage can throw under private-browsing quotas or when access is
  // blocked by site settings — fall back silently rather than crashing the
  // whole app at boot.
  try {
    const value = localStorage.getItem(key);
    return value || fallback;
  } catch {
    return fallback;
  }
};

const writeStorage = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota / security — ignore; user preference simply won't persist */
  }
};

const TokenWiring: React.FC = () => {
  const { instance, accounts } = useMsal();

  useEffect(() => {
    const account = accounts[0];
    if (!account) {
      setTokenGetter(null);
      setTokenForceRefreshGetter(null);
      return;
    }
    const scopes = getMsalScopes();
    setTokenGetter(async () => {
      const result = await instance.acquireTokenSilent({ scopes, account });
      // OATS observation: the id_token is the right thing to send to a same-app
      // backend — its audience is the SPA's clientId, which matches what the
      // backend's JWT validator expects. The accessToken's audience is Graph.
      return result.idToken || result.accessToken;
    });
    setTokenForceRefreshGetter(async () => {
      const result = await instance.acquireTokenSilent({
        scopes,
        account,
        forceRefresh: true,
      });
      return result.idToken || result.accessToken;
    });
    setAuthFailureHandler(() => {
      performLoginRedirect(instance).catch(() => {
        /* fall through; user will see the AuthGuard redirect-error UI */
      });
    });
  }, [instance, accounts]);

  return null;
};

const AppShell: React.FC<{
  currentUser: CurrentUser | null;
  jiraLinked: boolean;
  onSignOut: () => void;
  onLinkJira: () => void;
  theme: string;
  onToggleTheme: () => void;
  children: React.ReactNode;
}> = ({ currentUser, jiraLinked, onSignOut, onLinkJira, theme, onToggleTheme, children }) => (
  <div className="app">
    <header>
      <div className="header-row">
        <div className="header-title">
          <Link className="home-link" to="/" aria-label="Go to dashboards">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5.5a1 1 0 0 1-1-1v-5h-3v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9.5Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
          <div>
            <h1>Delivery Tracker</h1>
            <p>Jira roadmaps + local UAT/Live/milestones</p>
            <nav className="header-nav">
              <a href="/release-notes">Release notes</a>
              {currentUser?.role === 'admin' && <Link to="/admin/users">Admin</Link>}
            </nav>
          </div>
        </div>
        <div className="header-actions">
          {currentUser && (
            <>
              <span className="badge">
                <span className="badge-dot" style={{ background: '#22c55e' }} />
                {currentUser.displayName ?? 'Signed in'} · {currentUser.role}
              </span>
              {jiraLinked ? (
                <button
                  className="secondary"
                  onClick={() =>
                    unlinkJira().catch(() => {
                      /* error surfaced via forbidden toast */
                    })
                  }
                >
                  Unlink Jira
                </button>
              ) : (
                <button className="secondary" onClick={onLinkJira}>
                  Link Jira
                </button>
              )}
              <button className="secondary" onClick={onSignOut}>
                Sign out
              </button>
            </>
          )}
          <button className="secondary" onClick={onToggleTheme}>
            {theme === 'light' ? 'Switch to dark' : 'Switch to light'}
          </button>
        </div>
      </div>
    </header>
    {children}
  </div>
);

const App: React.FC = () => {
  const { instance, accounts } = useMsal();
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [jiraLinked, setJiraLinked] = useState(false);
  const [theme, setTheme] = useState(() => readStorage(themeStorageKey, 'dark'));
  const [forbiddenMessage, setForbiddenMessage] = useState<string | null>(null);

  const refreshSession = () => {
    fetchSession()
      .then((session) => {
        setCurrentUser(session.user ?? null);
        setJiraLinked(Boolean(session.jiraLinked));
      })
      .catch(() => {
        setCurrentUser(null);
        setJiraLinked(false);
      });
  };

  // Fetch the in-app user/role + Jira-link status as soon as MSAL reports an
  // account. Re-runs on account change so a fresh sign-in immediately updates
  // the header.
  useEffect(() => {
    if (accounts.length > 0) {
      refreshSession();
    } else {
      setCurrentUser(null);
      setJiraLinked(false);
    }
  }, [accounts]);

  useEffect(() => {
    setForbiddenHandler((message) => setForbiddenMessage(message));
    return () => setForbiddenHandler(null);
  }, []);

  useEffect(() => {
    if (!forbiddenMessage) return;
    const id = window.setTimeout(() => setForbiddenMessage(null), 5000);
    return () => window.clearTimeout(id);
  }, [forbiddenMessage]);

  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
    writeStorage(themeStorageKey, theme);
  }, [theme]);

  // Re-fetch the session every 5 minutes so a role change applied by an admin
  // (e.g. demoted from editor to viewer) propagates without the user having
  // to reload. canEdit is derived from currentUser, so updating state here is
  // enough to gate UI affordances.
  useEffect(() => {
    if (accounts.length === 0) return;
    const id = window.setInterval(refreshSession, 5 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [accounts.length]);

  const signOut = () => {
    performLogoutRedirect(instance).catch(() => {
      // apiBase can legitimately be '' (same-origin deployment) — guard
      // before assigning so we don't navigate to about:blank.
      window.location.href = apiBase || '/';
    });
  };

  const handleLinkJira = async () => {
    // Browser navigations can't attach the Azure AD Bearer header, so we
    // fetch /api/jira/link (which sets the signed state cookie and returns
    // the Atlassian authorize URL), then navigate.
    try {
      const { auth_url } = await startJiraLink();
      window.location.href = auth_url;
    } catch {
      /* 401/403 surfaces via the existing handlers; nothing extra here. */
    }
  };

  const canEdit = currentUser?.role === 'editor' || currentUser?.role === 'admin';
  // Pages that work without Jira data still need a signed-in user. Pages that
  // need Jira data additionally require jiraLinked — we surface that via the
  // banner below rather than blocking the route.
  const authenticated = Boolean(currentUser);

  return (
    <BrowserRouter>
      <TokenWiring />
      <AuthGuard>
        <AppShell
          currentUser={currentUser}
          jiraLinked={jiraLinked}
          onSignOut={signOut}
          onLinkJira={handleLinkJira}
          theme={theme}
          onToggleTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        >
          {forbiddenMessage && (
            <div className="forbidden-toast" role="alert">
              {forbiddenMessage}
            </div>
          )}
          {authenticated && !jiraLinked && (
            <div className="jira-link-banner" role="status">
              <span>Link your Jira account to load roadmaps and live data.</span>
              <button onClick={handleLinkJira}>Link Jira</button>
            </div>
          )}
          <Routes>
            <Route path="/" element={<DashboardList authenticated={authenticated && canEdit} />} />
            <Route
              path="/dashboards/:slug"
              element={<DashboardPage authenticated={authenticated && canEdit} />}
            />
            <Route
              path="/dashboards/:slug/weekly-update"
              element={<WeeklyUpdatePage authenticated={authenticated && canEdit} />}
            />
            <Route path="/release-notes" element={<ReleaseNotesList />} />
            <Route path="/release-notes/:version" element={<ReleaseNotesPage />} />
            <Route
              path="/admin/users"
              element={
                currentUser?.role === 'admin' ? <AdminUsersPage /> : <Navigate to="/" replace />
              }
            />
            {/* Auth-code redirect lands here; bootstrapMsal handled the response. */}
            <Route path="/oauth/openid/callback" element={<Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AppShell>
      </AuthGuard>
    </BrowserRouter>
  );
};

export default App;
