import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { MobileNav } from './MobileNav';

function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" className="h-8 w-8" aria-hidden="true">
      <rect width="32" height="32" rx="8" className="fill-brand-600" />
      <path d="M9 23 16 8l7 15M11.5 18h9" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="relative flex h-16 items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-2.5 rounded-lg" aria-label="AcademiaPath home">
          <BrandMark />
          <span className="text-lg font-semibold tracking-tight text-brand-900">
            Academia<span className="text-brand-600">Path</span>
          </span>
        </Link>
        <div className="flex items-center gap-3">
          <Badge tone="brand" className="hidden sm:inline-flex">
            Development preview
          </Badge>
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
