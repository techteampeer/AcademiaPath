/** Shared table styles: horizontally scrollable on small screens, readable rows. */
export const tableClasses = {
  // relative: contains absolutely positioned sr-only text so it scrolls with the table instead of widening the page.
  wrapper: 'relative overflow-x-auto rounded-xl border border-slate-200 bg-white',
  table: 'min-w-full divide-y divide-slate-200 text-left text-sm',
  head: 'bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase',
  th: 'px-4 py-3 whitespace-nowrap',
  td: 'px-4 py-3 align-top text-slate-700',
  row: 'hover:bg-slate-50',
} as const;
