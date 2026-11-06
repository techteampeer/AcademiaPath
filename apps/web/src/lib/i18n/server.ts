import { cookies } from 'next/headers';
import type { Metadata } from 'next';
import { isLocale, LOCALE_COOKIE, MESSAGES, type Locale, type Messages } from './messages';

/** Interface language from the non-sensitive `ap_locale` cookie (server components only). English by default. */
export async function serverLocale(): Promise<Locale> {
  const stored = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(stored) ? stored : 'en';
}

/** Page `<title>` in the interface language (the root layout appends "· AcademiaPath"). */
export async function localizedTitle(key: keyof Messages['meta']): Promise<Metadata> {
  return { title: MESSAGES[await serverLocale()].meta[key] };
}
