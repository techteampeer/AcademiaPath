'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSession } from '@/components/session/SessionProvider';
import { api } from '@/lib/api/endpoints';
import type { MessagingSummary } from '@/lib/api/types';

/**
 * Near-real-time updates by polling (AP-026): `tick` runs every `intervalMs` while the component is mounted and
 * the page is visible. Calls never overlap, polling pauses in hidden tabs (and resumes with an immediate tick)
 * and stops on unmount. There is no push channel: delivery is "within a few seconds", not instant.
 */
export function usePolling(tick: () => Promise<void> | void, intervalMs: number, enabled = true) {
  const saved = useRef(tick);
  useEffect(() => {
    saved.current = tick;
  }, [tick]);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let running = false;
    const schedule = () => {
      if (!stopped && document.visibilityState === 'visible') timer = setTimeout(run, intervalMs);
    };
    const run = async () => {
      timer = null;
      if (running || stopped) return;
      running = true;
      try {
        await saved.current();
      } catch {
        // A failed poll is retried at the next interval.
      } finally {
        running = false;
        schedule();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (!timer && !running) void run();
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, enabled]);
}

type SummaryValue = { summary: MessagingSummary | null; refresh: () => Promise<void> };
const SummaryContext = createContext<SummaryValue | null>(null);

/** Unread messages and notifications for the navigation and dashboard, polled every 30 seconds while visible. */
export function UnreadSummaryProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const authenticated = session.status === 'authenticated';
  const [summary, setSummary] = useState<MessagingSummary | null>(null);
  const refresh = useCallback(async () => {
    if (!authenticated) return;
    try {
      setSummary(await api.messagingSummary());
    } catch {
      // Keep the last known counts; the next poll tries again.
    }
  }, [authenticated]);
  useEffect(() => {
    if (authenticated) void refresh();
    else setSummary(null);
  }, [authenticated, refresh]);
  usePolling(refresh, 30_000, authenticated);
  return <SummaryContext.Provider value={{ summary, refresh }}>{children}</SummaryContext.Provider>;
}

export function useUnreadSummary(): SummaryValue {
  return useContext(SummaryContext) ?? { summary: null, refresh: async () => {} };
}

/** A fresh idempotency key for one message: kept until that message is sent, so a retry never duplicates it. */
export const newClientMessageId = () => crypto.randomUUID();
