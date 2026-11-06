'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { useSession } from '@/components/session/SessionProvider';
import { describeApiError, useCsrfAction } from '@/components/session/useCsrfAction';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { TextField } from '@/components/ui/Field';
import { isApiError } from '@/lib/api/client';
import { api } from '@/lib/api/endpoints';
import type { Program, ProgramManager } from '@/lib/api/types';
import { formatDate } from '@/lib/i18n/messages';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Administrator card in Academic structure → program: who may manage this program's subjects. Grants
 * and revocations go through the API, which allows them for administrators only.
 */
export function ProgramManagersPanel({ program }: { program: Program }) {
  const { t, locale } = useLocale();
  const p = t.programs;
  const { handleUnauthorized } = useSession();
  const { run, pending, result } = useCsrfAction();
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: ProgramManager[] }>({ status: 'loading' });
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState({ status: 'ready', items: (await api.listProgramManagers(program.id)).items });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setState({ status: 'error', message: describeApiError(error, locale) });
    }
  }, [program.id, handleUnauthorized, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!EMAIL_PATTERN.test(email.trim())) return setEmailError(p.emailInvalid);
    setEmailError(undefined);
    const granted = await run((csrf) => api.grantProgramManager(program.id, email.trim(), csrf), (value) => p.managerAdded(value.user.email));
    if (granted) {
      setEmail('');
      await load();
    }
  };
  const remove = async (manager: ProgramManager) => {
    const removed = await run(
      async (csrf) => {
        await api.revokeProgramManager(program.id, manager.user.id, csrf);
        return true;
      },
      () => p.managerRemoved(manager.user.email),
    );
    setConfirming(null);
    if (removed) await load();
  };

  return (
    <Card as="section" aria-labelledby="program-managers-heading" className="space-y-4">
      <div>
        <h3 id="program-managers-heading" className="text-lg font-semibold text-slate-900">
          {p.managersTitle}
        </h3>
        <p className="text-sm text-slate-600">{p.managersIntro}</p>
      </div>
      {result ? <Alert tone={result.tone}>{result.message}</Alert> : null}
      {state.status === 'loading' ? (
        <p role="status" className="text-sm text-slate-600">
          {p.loadingManagers}
        </p>
      ) : state.status === 'error' ? (
        <Alert tone="error">{state.message}</Alert>
      ) : state.items.length === 0 ? (
        <p className="text-sm text-slate-600">{p.noManagers}</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200" aria-label={p.managersTitle}>
          {state.items.map((manager) => (
            <li key={manager.user.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="font-medium text-slate-900">
                  {manager.user.givenName} {manager.user.familyName}
                </p>
                <p className="text-xs break-all text-slate-500">{manager.user.email}</p>
                <p className="text-xs text-slate-500">
                  {manager.grantedBy ? p.grantedBy(manager.grantedBy.email, formatDate(manager.grantedAt, locale)) : p.grantedOn(formatDate(manager.grantedAt, locale))}
                </p>
                {manager.user.isActive ? null : (
                  <Badge tone="warning" className="mt-1">
                    {p.managerInactive}
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {confirming === manager.user.id ? (
                  <>
                    <Button size="sm" disabled={pending} onClick={() => void remove(manager)}>
                      {p.confirmRemove}
                      <span className="sr-only">: {manager.user.email}</span>
                    </Button>
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(null)}>
                      {p.cancel}
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="secondary" disabled={pending} onClick={() => setConfirming(manager.user.id)}>
                    {p.remove}
                    <span className="sr-only">: {manager.user.email}</span>
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <form noValidate onSubmit={add} aria-labelledby="add-manager-heading" className="space-y-3 border-t border-slate-200 pt-4">
        <h4 id="add-manager-heading" className="font-semibold text-slate-900">
          {p.addManagerTitle}
        </h4>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <TextField id="program-manager-email" className="min-w-0 flex-1" label={p.managerEmail} type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={emailError} />
          <Button type="submit" disabled={pending}>
            {p.addManager}
          </Button>
        </div>
      </form>
    </Card>
  );
}
