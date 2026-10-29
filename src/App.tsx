import { Component, lazy, Suspense, useEffect, type ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppProvider, useRepository, useSnapshot } from '@/app/AppContext';
import { AppShell, Logo } from '@/components/layout/AppShell';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { ToastProvider } from '@/components/ui/Toast';
import { ConfirmProvider } from '@/components/ui/Dialog';
import { Skeleton } from '@/components/ui/Misc';
import { Button } from '@/components/ui/Button';
import { TransactionFormProvider } from '@/features/transactions/TransactionForm';
import { Onboarding } from '@/pages/Onboarding';
import { I18nProvider, useI18n } from '@/i18n/I18nProvider';
import { isLang } from '@/i18n/languages';
import { t } from '@/i18n/core';

const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Transactions = lazy(() => import('@/pages/Transactions'));
const Budgets = lazy(() => import('@/pages/Budgets'));
const Accounts = lazy(() => import('@/pages/Accounts'));
const Goals = lazy(() => import('@/pages/Goals'));
const Recurring = lazy(() => import('@/pages/Recurring'));
const Debts = lazy(() => import('@/pages/Debts'));
const NetWorth = lazy(() => import('@/pages/NetWorth'));
const Analytics = lazy(() => import('@/pages/Analytics'));
const Report = lazy(() => import('@/pages/Report'));
const Forecast = lazy(() => import('@/pages/Forecast'));
const Assistant = lazy(() => import('@/pages/Assistant'));
const Settings = lazy(() => import('@/pages/Settings'));
const Import = lazy(() => import('@/pages/Import'));

function PageFallback() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label={t('app.loading')}>
      <Skeleton className="h-8 w-56" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto mt-20 max-w-md px-6 text-center">
        <div className="display text-xl font-semibold">{t('app.error.title')}</div>
        <p className="mt-2 text-sm text-muted">{t('app.error.text')}</p>
        <Button variant="primary" className="mt-6" onClick={() => (window.location.hash = '#/', window.location.reload())}>
          {t('app.error.reload')}
        </Button>
      </div>
    );
  }
}

/** Réinitialise la frontière d'erreur à chaque changement de page. */
function RoutedBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [location.pathname]);
  return <ErrorBoundary key={location.pathname}>{children}</ErrorBoundary>;
}

function Root() {
  const repo = useRepository();
  const snapshot = useSnapshot(repo);
  const { lang, changeLanguage } = useI18n();
  if (snapshot === undefined) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="animate-pulse">
          <Logo />
        </div>
      </div>
    );
  }
  if (snapshot?.settings.onboarded && snapshot.settings.language !== lang && isLang(snapshot.settings.language)) {
    // Langue enregistrée différente (ex : sauvegarde restaurée) : on l'applique.
    changeLanguage(snapshot.settings.language);
    return null;
  }
  if (snapshot === null || !snapshot.settings.onboarded) return <Onboarding repo={repo} existing={snapshot?.settings} />;
  return (
    <AppProvider repo={repo} data={snapshot}>
      <TransactionFormProvider>
        <AppShell>
          <RoutedBoundary>
            <Suspense fallback={<PageFallback />}>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/transactions" element={<Transactions />} />
                <Route path="/budgets" element={<Budgets />} />
                <Route path="/accounts" element={<Accounts />} />
                <Route path="/goals" element={<Goals />} />
                <Route path="/recurring" element={<Recurring />} />
                <Route path="/debts" element={<Debts />} />
                <Route path="/net-worth" element={<NetWorth />} />
                <Route path="/analytics" element={<Analytics />} />
                <Route path="/report" element={<Report />} />
                <Route path="/forecast" element={<Forecast />} />
                <Route path="/assistant" element={<Assistant />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/import" element={<Import />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </RoutedBoundary>
        </AppShell>
      </TransactionFormProvider>
    </AppProvider>
  );
}

export function App() {
  return (
    <I18nProvider>
      <HashRouter>
        <TooltipProvider>
          <ToastProvider>
            <ConfirmProvider>
              <Root />
            </ConfirmProvider>
          </ToastProvider>
        </TooltipProvider>
      </HashRouter>
    </I18nProvider>
  );
}
