import type { Metadata } from 'next';
import { localizedTitle } from '@/lib/i18n/server';
import { LoginForm } from '@/components/session/LoginForm';

export async function generateMetadata(): Promise<Metadata> {
  return localizedTitle('signIn');
}

export default function LoginPage() {
  return <LoginForm />;
}
