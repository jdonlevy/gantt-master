import React, { useEffect, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import { performLoginRedirect } from './authHelpers';
import { getMsalScopes } from './msalBootstrap';

interface Props {
  children: React.ReactNode;
}

type CheckState = 'pending' | 'ok' | 'expired';

export const AuthGuard: React.FC<Props> = ({ children }) => {
  const { accounts, instance } = useMsal();
  const [redirectError, setRedirectError] = useState<string | null>(null);
  const [checkState, setCheckState] = useState<CheckState>(
    accounts.length === 0 ? 'ok' : 'pending'
  );

  useEffect(() => {
    if (accounts.length === 0) {
      performLoginRedirect(instance).catch((err: unknown) => {
        setRedirectError(err instanceof Error ? err.message : 'Login redirect failed');
      });
    }
  }, [accounts.length, instance]);

  useEffect(() => {
    if (accounts.length === 0) return;
    setCheckState('pending');
    instance
      .acquireTokenSilent({ scopes: getMsalScopes(), account: accounts[0] })
      .then(() => setCheckState('ok'))
      .catch(() => {
        // Any silent failure (InteractionRequired, network, etc.) — flip to
        // 'expired' so the redirect effect below kicks off interactive login.
        setCheckState('expired');
      });
  }, [accounts, instance]);

  useEffect(() => {
    if (checkState !== 'expired') return;
    performLoginRedirect(instance).catch(() => {
      /* fall through to redirect-error UI */
    });
  }, [checkState, instance]);

  if (accounts.length === 0) {
    if (redirectError) {
      return (
        <div className="auth-fallback">
          <p className="auth-error">Sign-in failed: {redirectError}</p>
          <button
            onClick={() => {
              setRedirectError(null);
              performLoginRedirect(instance).catch(() => {
                /* error surfaced via redirectError */
              });
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return null;
  }

  if (checkState === 'pending') {
    return <div className="auth-fallback">Signing in…</div>;
  }
  if (checkState === 'expired') {
    return <div className="auth-fallback">Your session has expired. Signing you in…</div>;
  }
  return <>{children}</>;
};
