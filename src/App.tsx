import { lazy, Suspense, type ReactNode } from 'react';
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

/** Fournisseurs communs aux deux modes (aucun n'utilise le routeur). */
function Providers({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <ToastProvider>
        <ConfirmProvider>
          {/* Filet global : une donnée inattendue dans AppProvider / AppShell (hors pages)
              affiche un écran d'erreur au lieu d'une page blanche. */}
          <ErrorBoundary>{children}</ErrorBoundary>
        </ConfirmProvider>
      </ToastProvider>
    </TooltipProvider>
  );
}

export function App() {
  return (
    <I18nProvider>
      {getBackendSelection().requested === 'supabase' ? (
        // Mode Cloud : PAS de routeur ici. `CloudApp` monte le HashRouter lui-même, APRÈS
        // l'initialisation du SDK (échange du code PKCE du lien de confirmation, V3.2 / V3.7) ;
        // barrière d'authentification ; la base locale n'est jamais ouverte.
        <Providers>
          <Suspense fallback={<Splash />}>
            <CloudApp />
          </Suspense>
        </Providers>
      ) : (
        // Mode local : arbre inchangé (routeur autour des fournisseurs).
        <HashRouter>
          <Providers>
            <Root />
          </Providers>
        </HashRouter>
      )}
    </I18nProvider>
  );
}
