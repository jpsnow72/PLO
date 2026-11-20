// Google Identity Services (GIS) loader — the "Sign in with Google"
// button flow. The GIS script is loaded from Google on demand (only when
// the server says Google sign-in is on, via GET /api/auth/config); its
// callback hands us an ID token, which lib/api.ts exchanges for the
// admin session. No client secret exists in this flow — the client id
// is public configuration served by the API.
//
// Only the slice of the GIS surface we use is typed here.

export interface GoogleCredentialResponse {
  /** The ID token (JWT) to post to /api/auth/google. */
  credential?: string;
  select_by?: string;
}

export interface GoogleButtonOptions {
  theme?: string;
  size?: string;
  text?: string;
  shape?: string;
  width?: number;
}

interface GoogleAccountsId {
  initialize: (config: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
  }) => void;
  renderButton: (parent: HTMLElement, options: GoogleButtonOptions) => void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
  }
}

const GSI_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

let scriptPromise: Promise<void> | null = null;

/** Load the GIS client script once; resolves when window.google is ready. */
export function loadGoogleSignInScript(): Promise<void> {
  if (typeof window !== 'undefined' && window.google?.accounts?.id) {
    return Promise.resolve();
  }
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GSI_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null; // a later mount may retry
      reject(new Error('Google sign-in script failed to load'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/** The GIS accounts.id surface, or null when the script has not loaded. */
export function googleAccountsId(): GoogleAccountsId | null {
  if (typeof window === 'undefined') return null;
  return window.google?.accounts?.id ?? null;
}
