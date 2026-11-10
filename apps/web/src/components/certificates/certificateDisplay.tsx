'use client';

import { useState } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api/endpoints';
import type { Certificate, CertificateEligibility } from '@/lib/api/types';

export function CertificateStatusBadge({ status }: { status: Certificate['status'] }) {
  const { t } = useLocale();
  return (
    <span data-certificate-status={status}>
      <Badge tone={status === 'issued' ? 'success' : 'warning'}>{t.certificates.status[status]}</Badge>
    </span>
  );
}

export function EligibilityBadge({ eligible }: { eligible: boolean }) {
  const { t } = useLocale();
  return (
    <span data-eligible={String(eligible)}>
      <Badge tone={eligible ? 'success' : 'neutral'}>{eligible ? t.certificates.eligible : t.certificates.notEligible}</Badge>
    </span>
  );
}

/** Each requirement with a plain reason; grades shown here are released grades only (from the API). */
export function RequirementList({ eligibility, compact = false }: { eligibility: CertificateEligibility; compact?: boolean }) {
  const { t } = useLocale();
  const c = t.certificates;
  return (
    <div className="space-y-2">
      <ul className={compact ? 'space-y-1 text-xs' : 'space-y-2 text-sm'}>
        {eligibility.requirements.map((requirement) => (
          <li key={requirement.key} className="flex items-start gap-2" data-requirement={requirement.key} data-met={String(requirement.met)}>
            <span aria-hidden="true" className={requirement.met ? 'text-emerald-600' : 'text-amber-600'}>
              {requirement.met ? '✓' : '○'}
            </span>
            <span>
              <span className="font-medium text-slate-900">{c.requirement[requirement.key]}</span>
              <span className="sr-only"> — {requirement.met ? c.met : c.notMet}</span>
              {!requirement.met && requirement.reason ? <span className="block text-slate-600">{c.reason[requirement.reason]}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {!compact ? (
        <p className="text-xs text-slate-500">
          {c.progress(eligibility.progress.completedCount, eligibility.progress.totalCount)} ·{' '}
          {c.releasedGrade(eligibility.releasedGrade.percent, eligibility.releasedGrade.status === 'final')}
        </p>
      ) : null}
    </div>
  );
}

/** Downloads the server-generated PDF; revoked certificates are refused by the API. */
export function DownloadCertificateButton({ certificateId, variant = 'primary' }: { certificateId: string; variant?: 'primary' | 'secondary' }) {
  const { t } = useLocale();
  const c = t.certificates;
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const download = async () => {
    setState('busy');
    try {
      const { blob, fileName } = await api.downloadCertificatePdf(certificateId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setState('idle');
    } catch {
      setState('failed');
    }
  };
  return (
    <span className="inline-flex flex-col gap-1">
      <Button size="sm" variant={variant} onClick={() => void download()} disabled={state === 'busy'}>
        {state === 'busy' ? c.downloading : c.download}
      </Button>
      {state === 'failed' ? <Alert tone="error">{c.downloadFailed}</Alert> : null}
    </span>
  );
}
