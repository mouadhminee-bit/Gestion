import { useId, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import * as Popover from '@radix-ui/react-popover';
import { Bell, ChevronLeft, ChevronRight, Eye, EyeOff, Moon, MoreHorizontal, Plus, Sun, X, CheckCheck, FlaskConical } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { NAV, NAV_GROUPS, navLabel, navShort } from '@/app/nav';
import { t } from '@/i18n/core';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { Dialog } from '@/components/ui/Dialog';
import { useTransactionForm } from '@/features/transactions/TransactionForm';
import { computeNotifications } from '@/domain/calc/notifications';
import { addMonthsToKey, monthKey } from '@/domain/dates';

export function Logo({ compact }: { compact?: boolean }) {
  // Identifiant unique : plusieurs logos coexistent (sidebar masquée + barre mobile).
  const gid = `nx-g-${useId().replace(/:/g, '')}`;
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 64 64" className="h-8 w-8 shrink-0" aria-hidden>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#41E7F5" />
            <stop offset=".5" stopColor="#5271FF" />
            <stop offset="1" stopColor="#9B7BFF" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="16" fill="rgb(var(--surface-3))" />
        <path d="M18 46V18l28 28V18" fill="none" stroke={`url(#${gid})`} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {!compact && (
        <div className="leading-none">
          <div className="display text-[15px] font-bold tracking-[0.18em]">NEXORA</div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-muted">{t('shell.tagline')}</div>
        </div>
      )}
    </div>
  );
}

function Sidebar() {
  const groups = Object.entries(NAV_GROUPS) as [keyof typeof NAV_GROUPS, string][];
  return (
    <aside className="no-print fixed inset-y-0 start-0 z-30 hidden w-[248px] flex-col border-e border-line/10 bg-surface/70 backdrop-blur-xl lg:flex">
      <div className="px-5 pb-4 pt-5">
        <Logo />
      </div>
      <div className="glow-line mx-5 opacity-60" />
      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label={t('shell.mainNav')}>
        {groups.map(([g, label]) => (
          <div key={g} className="mb-4">
            <div className="label px-3 pb-1.5 text-[10px]">{label}</div>
            {NAV.filter((n) => n.group === g).map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === '/'}
                className={({ isActive }) =>
                  cn(
                    'group relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition',
                    isActive ? 'bg-primary/12 text-fg' : 'text-muted hover:bg-surface-2/70 hover:text-fg',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && <span className="absolute start-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-e-full bg-gradient-to-b from-cyan to-primary" />}
                    <n.icon className={cn('h-[18px] w-[18px]', isActive ? 'text-cyan' : '')} aria-hidden />
                    {navLabel(n)}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="px-5 pb-5 text-[11px] leading-relaxed text-muted/80">
        {t('shell.localData')}
        <br />
        {t('shell.noBank')}
      </div>
    </aside>
  );
}

function MonthSwitcher() {
  const { month, setMonth, fmt, today } = useApp();
  const current = monthKey(today);
  return (
    <div className="flex items-center rounded-xl border border-line/15 bg-surface-2/60">
      <Button variant="ghost" size="icon-sm" aria-label={t('shell.prevMonth')} onClick={() => setMonth(addMonthsToKey(month, -1))}>
        <ChevronLeft className="h-4 w-4 rtl:-scale-x-100" />
      </Button>
      <button className="min-w-[104px] px-0.5 text-center text-sm font-medium sm:min-w-[132px]" onClick={() => setMonth(current)} title={t('shell.currentMonth')}>
        {fmt.month(month)}
      </button>
      <Button variant="ghost" size="icon-sm" aria-label={t('shell.nextMonth')} onClick={() => setMonth(addMonthsToKey(month, 1))}>
        <ChevronRight className="h-4 w-4 rtl:-scale-x-100" />
      </Button>
    </div>
  );
}

function Notifications() {
  const { ctx, data, today, fmt, repo, settings } = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const items = useMemo(() => computeNotifications(ctx, data, today, (m) => fmt.money(m), settings.dateFormat), [ctx, data, today, fmt, settings.dateFormat]);
  const unread = items.filter((i) => !i.read).length;
  const tone = { danger: 'bg-negative', warning: 'bg-warning', info: 'bg-cyan', success: 'bg-positive' };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="icon" aria-label={unread ? t('shell.notificationsUnread', { count: unread }) : t('shell.notifications')} className="relative">
          <Bell className="h-5 w-5" />
          {unread > 0 && <span className="absolute end-2 top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-negative px-1 text-[10px] font-bold text-white">{unread}</span>}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} collisionPadding={12} className="z-[60] w-[min(380px,calc(100vw-24px))] rounded-2xl border border-line/15 bg-surface shadow-2xl animate-fade-in">
          <div className="flex items-center justify-between border-b border-line/10 px-4 py-3">
            <div className="text-sm font-semibold">{t('shell.notifications')}</div>
            {items.length > 0 && (
              <button className="inline-flex items-center gap-1 text-xs text-cyan hover:underline" onClick={() => repo.setNotificationState(items.map((i) => i.id), { read: true })}>
                <CheckCheck className="h-3.5 w-3.5" /> {t('shell.markAllRead')}
              </button>
            )}
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-2">
            {items.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted">{t('shell.noAlerts')}</p>}
            {items.map((n) => (
              <div key={n.id} className={cn('group relative flex gap-3 rounded-xl px-3 py-2.5 hover:bg-surface-2', n.read && 'opacity-60')}>
                <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', tone[n.severity])} />
                <button
                  className="min-w-0 flex-1 text-start"
                  onClick={() => {
                    repo.setNotificationState([n.id], { read: true });
                    setOpen(false);
                    navigate(n.href);
                  }}
                >
                  <div className="text-sm font-medium">{n.title}</div>
                  <div className="mt-0.5 text-xs text-muted">{n.message}</div>
                </button>
                <button aria-label={t('shell.hide')} className="h-6 w-6 shrink-0 rounded-md text-muted opacity-0 hover:text-fg group-hover:opacity-100 focus:opacity-100" onClick={() => repo.setNotificationState([n.id], { dismissed: true })}>
                  <X className="mx-auto h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          <div className="border-t border-line/10 px-4 py-2.5 text-[11px] text-muted">{t('shell.alertsHint')}</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function TopBar() {
  const { settings, repo } = useApp();
  const openForm = useTransactionForm();
  const navigate = useNavigate();
  return (
    <header className="no-print sticky top-0 z-20 border-b border-line/10 bg-bg/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-1.5 px-3 sm:gap-2 sm:px-6">
        <div className="hidden sm:block lg:hidden">
          <Logo compact />
        </div>
        <MonthSwitcher />
        {settings.demoMode && (
          <Tooltip content={t('shell.demoTooltip')}>
            <button onClick={() => navigate('/settings#data')} className="hidden items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-warning sm:inline-flex">
              <FlaskConical className="h-3.5 w-3.5" /> {t('shell.demo')}
            </button>
          </Tooltip>
        )}
        <div className="ms-auto flex items-center gap-0.5 sm:gap-1">
          <Tooltip content={settings.privacyMode ? t('shell.showAmounts') : t('shell.hideAmounts')}>
            <Button variant="ghost" size="icon" aria-pressed={settings.privacyMode} aria-label={t('shell.privacyMode')} onClick={() => repo.updateSettings({ privacyMode: !settings.privacyMode })}>
              {settings.privacyMode ? <EyeOff className="h-5 w-5 text-cyan" /> : <Eye className="h-5 w-5" />}
            </Button>
          </Tooltip>
          <Tooltip content={settings.theme === 'dark' ? t('shell.lightTheme') : t('shell.darkTheme')}>
            <Button variant="ghost" size="icon" className="hidden sm:inline-flex" aria-label={t('shell.toggleTheme')} onClick={() => repo.updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })}>
              {settings.theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </Button>
          </Tooltip>
          <Notifications />
          <Button variant="primary" className="ms-1 hidden sm:inline-flex" icon={<Plus className="h-4 w-4" />} onClick={() => openForm()}>
            {t('shell.addTransaction')}
          </Button>
          <NavLink to="/settings" aria-label={t('shell.profile')} className="ms-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-cyan/80 via-primary to-violet text-xs font-bold text-white">
            {(settings.displayName || 'N').slice(0, 1).toUpperCase()}
          </NavLink>
        </div>
      </div>
    </header>
  );
}

function BottomNav() {
  const openForm = useTransactionForm();
  const [more, setMore] = useState(false);
  const location = useLocation();
  const primary = NAV.slice(0, 2);
  const secondary = NAV.slice(2, 3);
  const item = (n: (typeof NAV)[number]) => (
    <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => cn('flex flex-1 flex-col items-center gap-1 py-2 text-[10px] font-medium', isActive ? 'text-cyan' : 'text-muted')}>
      <n.icon className="h-5 w-5" aria-hidden />
      {navShort(n)}
    </NavLink>
  );
  const inMore = NAV.slice(3).some((n) => location.pathname.startsWith(n.to));
  return (
    <>
      <nav className="no-print fixed inset-x-0 bottom-0 z-40 border-t border-line/10 bg-surface/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden" aria-label={t('shell.mobileNav')}>
        <div className="mx-auto flex max-w-md items-end px-2">
          {primary.map(item)}
          <div className="flex flex-1 justify-center">
            <button onClick={() => openForm()} aria-label={t('shell.addTransaction')} className="-mt-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan via-primary to-violet text-white shadow-glow active:scale-95">
              <Plus className="h-6 w-6" />
            </button>
          </div>
          {secondary.map(item)}
          <button onClick={() => setMore(true)} className={cn('flex flex-1 flex-col items-center gap-1 py-2 text-[10px] font-medium', inMore ? 'text-cyan' : 'text-muted')}>
            <MoreHorizontal className="h-5 w-5" aria-hidden />
            {t('shell.more')}
          </button>
        </div>
      </nav>
      <Dialog open={more} onOpenChange={setMore} title={t('shell.modules')} size="sm">
        <div className="grid grid-cols-3 gap-2 pb-2">
          {NAV.slice(3).map((n) => (
            <NavLink key={n.to} to={n.to} onClick={() => setMore(false)} className={({ isActive }) => cn('flex flex-col items-center gap-2 rounded-2xl border border-line/10 bg-surface-2/60 px-2 py-4 text-center text-xs font-medium', isActive && 'border-primary/40 text-cyan')}>
              <n.icon className="h-5 w-5" />
              {navShort(n)}
            </NavLink>
          ))}
        </div>
      </Dialog>
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-[100] focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2">
        {t('shell.skip')}
      </a>
      <Sidebar />
      <div className="app-content lg:ps-[248px]">
        <TopBar />
        <main id="main" className="print-full mx-auto max-w-[1400px] px-4 pb-28 pt-5 sm:px-6 sm:pt-7 lg:pb-12">
          {children}
        </main>
      </div>
      <BottomNav />
    </div>
  );
}
