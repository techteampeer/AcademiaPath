import type { ReactNode } from 'react';

/** A single real figure with its label (never estimated or invented). */
export function StatCard({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-panel">
      <dt className="text-sm font-medium text-slate-600">{label}</dt>
      <dd className="mt-1 font-serif text-3xl font-semibold text-brand-600">{value}</dd>
      {hint ? <dd className="mt-1 text-xs text-slate-500">{hint}</dd> : null}
    </div>
  );
}
