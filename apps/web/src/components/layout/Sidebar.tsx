import { NavLinks } from './NavLinks';

/** Persistent navigation for large screens; hidden (and removed from the accessibility tree) below `lg`. */
export function Sidebar() {
  return (
    <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-slate-50 lg:block">
      <nav aria-label="Main" className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto px-3 py-6">
        <NavLinks idPrefix="sidebar-nav" />
      </nav>
    </aside>
  );
}
