'use client';

import { useCallback, useState } from 'react';
import type { Locale, Messages } from '@/lib/i18n/messages';
import { useLocale } from './LocaleProvider';

/** Builds a value (usually interface text) from the catalog of the language currently selected. */
export type Localize<T> = (t: Messages, locale: Locale) => T;

/**
 * AP-I18N-01: state for messages shown to the user (validation errors, notices, API errors). Instead of a finished
 * string, it can keep a function of the catalog, evaluated on every render, so a message already on screen follows
 * the EN/ES switch instead of staying in the language it was first shown in. Plain values (null, an empty object…)
 * are kept as they are. `T` must not itself be a function type.
 */
export function useLocalizedState<T>(initial: T): [T, (next: T | Localize<T>) => void] {
  const { t, locale } = useLocale();
  const [stored, setStored] = useState<{ value: T } | { produce: Localize<T> }>({ value: initial });
  const set = useCallback((next: T | Localize<T>) => setStored(typeof next === 'function' ? { produce: next as Localize<T> } : { value: next }), []);
  return ['produce' in stored ? stored.produce(t, locale) : stored.value, set];
}
