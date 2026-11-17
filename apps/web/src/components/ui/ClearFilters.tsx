'use client';

import { useLocale } from '@/components/i18n/LocaleProvider';
import { Button } from './Button';

/**
 * AP-QA-02 (TC-14): the one "Clear filters" action shared by catalogs with a search field and filters. It is shown
 * only while a filter is active, resets every filter at once (the catalog's own `onClear`) and then moves focus to the
 * search field, because the button itself disappears. Filtering and authorization stay with each catalog and the API.
 */
export function ClearFilters({ active, onClear, focusId }: { active: boolean; onClear: () => void; focusId: string }) {
  const { t } = useLocale();
  if (!active) return null;
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => {
        onClear();
        document.getElementById(focusId)?.focus();
      }}
    >
      {t.common.clearFilters}
    </Button>
  );
}
