'use client';

import { useEffect, useRef, useState } from 'react';
import { SessionSummary } from '@/components/session/SessionControls';
import { NavLinks } from './NavLinks';

const PANEL_ID = 'mobile-navigation';

/** Menu button and dropdown navigation shown below the `lg` breakpoint. */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100"
      >
        <span className="sr-only">{open ? 'Close navigation menu' : 'Open navigation menu'}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-6 w-6" aria-hidden="true">
          {open ? (
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5" />
          )}
        </svg>
      </button>

      {open ? (
        <nav
          id={PANEL_ID}
          aria-label="Main"
          className="absolute inset-x-0 top-full border-b border-slate-200 bg-white px-4 py-4 shadow-lg sm:px-6"
        >
          <SessionSummary />
          <NavLinks idPrefix="mobile-nav" onNavigate={() => setOpen(false)} />
        </nav>
      ) : null}
    </div>
  );
}
