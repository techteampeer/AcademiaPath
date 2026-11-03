'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { CurrentUser, LoginRequest } from '@/lib/api/types';

export type SessionState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; user: CurrentUser };

type SessionContextValue = {
  session: SessionState;
  signIn: (credentials: LoginRequest) => Promise<void>;
  signOut: () => Promise<void>;
  /** CSRF token for the current session. Kept in memory only; fetched from the API after a reload. */
  getCsrfToken: () => Promise<string>;
  /** Call when an API request returns 401 (expired, revoked or missing session). */
  handleUnauthorized: () => void;
};

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Session state derived from GET /api/v1/me. The session token itself lives only in the HttpOnly
 * cookie; nothing about the session is written to localStorage or sessionStorage. Client-side
 * state only shapes the UI; the API enforces every permission.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });
  const csrfToken = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then(({ user }) => {
        if (!cancelled) setSession({ status: 'authenticated', user });
      })
      .catch(() => {
        // Fail closed: any error (401, network, server) means "not signed in" for the UI.
        if (!cancelled) setSession({ status: 'unauthenticated' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (credentials: LoginRequest) => {
    const result = await api.login(credentials);
    csrfToken.current = result.csrfToken;
    setSession({ status: 'authenticated', user: result.user });
  }, []);

  const handleUnauthorized = useCallback(() => {
    csrfToken.current = null;
    setSession({ status: 'unauthenticated' });
  }, []);

  const getCsrfToken = useCallback(async () => {
    if (csrfToken.current) return csrfToken.current;
    const { csrfToken: token } = await api.csrfToken();
    csrfToken.current = token;
    return token;
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout(await getCsrfToken());
    } catch (error) {
      // A 401 means the session already ended; anything else is reported to the caller.
      if (!isApiError(error, 401)) throw error;
    }
    handleUnauthorized();
  }, [getCsrfToken, handleUnauthorized]);

  const value = useMemo(
    () => ({ session, signIn, signOut, getCsrfToken, handleUnauthorized }),
    [session, signIn, signOut, getCsrfToken, handleUnauthorized],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}

export const SYSTEM_ROLE_LABELS: Record<CurrentUser['systemRole'], string> = {
  administrator: 'Administrator',
  user: 'User',
};
