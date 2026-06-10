import React from 'react';
import { createRoot } from 'react-dom/client';
import { MsalProvider } from '@azure/msal-react';
import App from './App';
import { bootstrapMsal } from './auth/msalBootstrap';
import './styles.css';

async function main() {
  const root = document.getElementById('root');
  if (!root) return;

  try {
    const { instance } = await bootstrapMsal();
    createRoot(root).render(
      <React.StrictMode>
        <MsalProvider instance={instance}>
          <App />
        </MsalProvider>
      </React.StrictMode>
    );
  } catch (err) {
    // Auth config fetch failed — render a minimal error state so the user
    // sees something rather than a blank page.
    createRoot(root).render(
      <div className="auth-fallback">
        <p className="auth-error">
          Could not initialise sign-in: {err instanceof Error ? err.message : 'unknown error'}
        </p>
      </div>
    );
  }
}

void main();
