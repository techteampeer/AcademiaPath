import type { ReactNode } from 'react';

/** A single real figure with its label (never estimated or invented). */
export function StatCard({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <dt className="text-sm font-medium text-slate-500">{label}</dt>
      <dd className="mt-1 text-3xl font-semibold tracking-tight text-slate-900">{value}</dd>
      {hint ? <dd className="mt-1 text-xs text-slate-500">{hint}</dd> : null}
    </div>
  );
}
