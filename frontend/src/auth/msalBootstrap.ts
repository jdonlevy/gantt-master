import {
  PublicClientApplication,
  type AccountInfo,
  type Configuration,
} from '@azure/msal-browser';
import { getEnv } from '../api';

let _instance: PublicClientApplication | null = null;
let _scopes: string[] = ['User.Read'];

export function getMsalInstance(): PublicClientApplication {
  if (!_instance) {
    throw new Error('MSAL not initialised — call bootstrapMsal() first');
  }
  return _instance;
}

export function getMsalScopes(): string[] {
  return _scopes;
}

export async function bootstrapMsal(): Promise<{
  instance: PublicClientApplication;
  account: AccountInfo | null;
}> {
  if (_instance) {
    return { instance: _instance, account: _instance.getActiveAccount() };
  }

  // Pod-injected via window.__ENV__ (see frontend Helm envVars in
  // terraform/frontend/api.tf and docker-entrypoint.sh).
  const env = getEnv();
  const clientId = env.VITE_AZURE_AD_CLIENT_ID;
  const tenantId = env.VITE_AZURE_AD_TENANT_ID;
  if (!clientId || !tenantId) {
    throw new Error('Azure AD config missing (VITE_AZURE_AD_CLIENT_ID / VITE_AZURE_AD_TENANT_ID)');
  }
  const authority = env.VITE_AZURE_AD_AUTHORITY || `https://login.microsoftonline.com/${tenantId}`;

  const msalConfig: Configuration = {
    auth: {
      clientId,
      authority,
      redirectUri: `${window.location.origin}/oauth/openid/callback`,
      navigateToLoginRequestUrl: true,
    },
    cache: {
      cacheLocation: 'localStorage',
      storeAuthStateInCookie: false,
    },
  };

  _instance = new PublicClientApplication(msalConfig);
  await _instance.initialize();

  const redirect = await _instance.handleRedirectPromise();
  if (redirect?.account) {
    _instance.setActiveAccount(redirect.account);
  } else {
    const accounts = _instance.getAllAccounts();
    if (accounts.length > 0) {
      _instance.setActiveAccount(accounts[0]);
    }
  }

  return { instance: _instance, account: _instance.getActiveAccount() };
}
