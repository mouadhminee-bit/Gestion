import { lazy, Suspense } from 'react';
import { HashRouter } from 'react-router-dom';
import { useRepository } from '@/app/AppContext';
import { ErrorBoundary, Splash, Workspace } from '@/app/Workspace';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { ToastProvider } from '@/components/ui/Toast';
import { ConfirmProvider } from '@/components/ui/Dialog';
import { I18nProvider } from '@/i18n/I18nProvider';
import { getBackendSelection } from '@/data/backend';

// Mode Cloud (VITE_DATA_BACKEND=supabase) : chargé à la demande ; le mode local ne charge ni ce module ni le SDK.
const CloudApp = lazy(() => import('@/features/auth/CloudApp'));

/** Mode local : dépôt local (base `nexora`), comportement inchangé. */
function Root() {
  return <Workspace repo={useRepository()} />;
}

export function App() {
  return (
    <I18nProvider>
      <HashRouter>
        <TooltipProvider>
          <ToastProvider>
            <ConfirmProvider>
              {/* Filet global : une donnée inattendue dans AppProvider / AppShell (hors pages)
                  affiche un écran d'erreur au lieu d'une page blanche. */}
              <ErrorBoundary>
                {getBackendSelection().requested === 'supabase' ? (
                  // Mode Cloud : barrière d'authentification ; la base locale n'est jamais ouverte.
                  <Suspense fallback={<Splash />}>
                    <CloudApp />
                  </Suspense>
                ) : (
                  <Root />
                )}
              </ErrorBoundary>
            </ConfirmProvider>
          </ToastProvider>
        </TooltipProvider>
      </HashRouter>
    </I18nProvider>
  );
}
