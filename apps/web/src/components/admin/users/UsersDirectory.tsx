'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocale } from '@/components/i18n/LocaleProvider';
import { RequireAuth } from '@/components/session/RequireAuth';
import { useSession } from '@/components/session/SessionProvider';
import { Alert } from '@/components/ui/Alert';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SelectField, TextField } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingCards } from '@/components/ui/Skeleton';
import { tableClasses } from '@/components/ui/table';
import { isApiError } from '@/lib/api/client';
import { api, type UserFilters } from '@/lib/api/endpoints';
import type { UserPage } from '@/lib/api/types';
import { AccountStatusBadge, ActivationBadge, SystemRoleBadge, useErrorMessage } from './userShared';

const PAGE_SIZE = 20;

export function UsersDirectory() {
  return <RequireAuth role="administrator">{() => <DirectoryContent />}</RequireAuth>;
}

function DirectoryContent() {
  const { t } = useLocale();
  const { handleUnauthorized } = useSession();
  const errorMessage = useErrorMessage();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<UserFilters>({ q: '', status: '', activation: '' });
  // Cursor of each visited page (index 0 = first page), so "Previous" never refetches from scratch.
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; page: UserPage }>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const page = await api.listUsers(filters, { limit: PAGE_SIZE, cursor: cursors[pageIndex] ?? null });
      setState({ status: 'ready', page });
    } catch (error) {
      if (isApiError(error, 401)) handleUnauthorized();
      setState({ status: 'error', message: errorMessage(error) });
    }
  }, [filters, cursors, pageIndex, handleUnauthorized, errorMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyFilters = (next: UserFilters) => {
    setFilters(next);
    setCursors([null]);
    setPageIndex(0);
  };
  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    applyFilters({ ...filters, q: search.trim() });
  };
  const goNext = () => {
    if (state.status !== 'ready' || !state.page.nextCursor) return;
    const nextCursor = state.page.nextCursor;
    setCursors((previous) => [...previous.slice(0, pageIndex + 1), nextCursor]);
    setPageIndex((index) => index + 1);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: t.nav.adminOverview, href: '/admin' }, { label: t.users.title }]}
        breadcrumbLabel={t.common.breadcrumb}
        title={t.users.title}
        description={t.users.intro}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/users/new" className={buttonClasses({ size: 'sm' })}>
              {t.users.newUser}
            </Link>
            <Link href="/admin/users/import" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
              {t.users.bulkEnroll}
            </Link>
          </div>
        }
      />
      <Card className="space-y-4">
        <form role="search" onSubmit={submitSearch} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <TextField
            id="user-search"
            className="min-w-0 flex-1"
            label={t.users.searchLabel}
            type="search"
            value={search}
            maxLength={100}
            placeholder={t.users.searchPlaceholder}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button type="submit" variant="secondary">
            {t.users.searchButton}
          </Button>
        </form>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            id="user-status"
            label={t.users.filterStatus}
            value={filters.status ?? ''}
            onChange={(event) => applyFilters({ ...filters, status: event.target.value as UserFilters['status'] })}
            options={[
              { value: '', label: t.common.all },
              { value: 'active', label: t.users.statusActive },
              { value: 'inactive', label: t.users.statusInactive },
            ]}
          />
          <SelectField
            id="user-activation"
            label={t.users.filterActivation}
            value={filters.activation ?? ''}
            onChange={(event) => applyFilters({ ...filters, activation: event.target.value as UserFilters['activation'] })}
            options={[
              { value: '', label: t.common.all },
              { value: 'activated', label: t.users.activated },
              { value: 'pending', label: t.users.pending },
            ]}
          />
        </div>
      </Card>

      {state.status === 'loading' ? (
        <LoadingCards label={t.common.loading} count={2} />
      ) : state.status === 'error' ? (
        <Alert tone="error">
          {state.message}{' '}
          <button type="button" className="font-medium underline" onClick={() => void load()}>
            {t.common.retry}
          </button>
        </Alert>
      ) : state.page.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-600">{t.users.noResults}</p>
      ) : (
        <div className={tableClasses.wrapper}>
          <table className={tableClasses.table}>
            <thead className={tableClasses.head}>
              <tr>
                <th scope="col" className={tableClasses.th}>{t.users.name}</th>
                <th scope="col" className={tableClasses.th}>{t.users.systemRole}</th>
                <th scope="col" className={tableClasses.th}>{t.users.courses}</th>
                <th scope="col" className={tableClasses.th}>{t.users.status}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {state.page.items.map((user) => (
                <tr key={user.id} className={tableClasses.row}>
                  <td className={tableClasses.td}>
                    <Link href={`/admin/users/${user.id}`} className="font-medium text-brand-700 hover:underline">
                      {user.givenName} {user.familyName}
                    </Link>
                    <div className="break-all text-xs text-slate-500">{user.email}</div>
                  </td>
                  <td className={tableClasses.td}>
                    <SystemRoleBadge role={user.systemRole} />
                  </td>
                  <td className={tableClasses.td}>
                    {user.activeEnrollmentCount === 0 ? (
                      <span className="text-slate-500">{t.users.noCourseRoles}</span>
                    ) : (
                      <>
                        <div>{t.users.courseCount(user.activeEnrollmentCount)}</div>
                        <div className="text-xs text-slate-500">{user.courseRoles.map((role) => t.roles[role]).join(', ')}</div>
                      </>
                    )}
                  </td>
                  <td className={tableClasses.td}>
                    <div className="flex flex-wrap gap-1">
                      <AccountStatusBadge isActive={user.isActive} />
                      <ActivationBadge state={user.activationState} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <nav aria-label={t.users.pagination} className="flex items-center justify-between gap-2">
        <Button variant="secondary" size="sm" disabled={pageIndex === 0 || state.status === 'loading'} onClick={() => setPageIndex((index) => Math.max(0, index - 1))}>
          {t.users.previous}
        </Button>
        <span className="text-sm text-slate-600" aria-live="polite">
          {t.users.pageLabel(pageIndex + 1)}
        </span>
        <Button variant="secondary" size="sm" disabled={state.status !== 'ready' || !state.page.nextCursor} onClick={goNext}>
          {t.users.next}
        </Button>
      </nav>
    </div>
  );
}
