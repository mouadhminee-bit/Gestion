/**
 * Application en mode Cloud (`VITE_DATA_BACKEND=supabase`, V2.5) — chargée à la demande :
 * le mode local ne charge ni ce module ni le SDK Supabase.
 *
 *  - configuration Cloud absente ou invalide → écran bloquant (aucun repli silencieux) ;
 *  - session en cours de vérification → écran d'attente (borné) ;
 *  - aucune session → écrans de connexion / création de compte uniquement ;
 *  - session vérifiée → espace Cloud minimal (compte, déconnexion).
 *
 * Aucune donnée financière : ni repository, ni base IndexedDB locale, ni requête de données
 * (les données Cloud relèvent d'une phase ultérieure).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Cloud, LogOut, RefreshCw } from 'lucide-react';
import { Logo } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { getBackendSelection, type BackendSelection } from '@/data/backend';
import type { AuthMessageKey, AuthPort } from '@/data/cloud/auth';
import { getSupabaseClient } from '@/data/cloud/supabaseClient';
import { t } from '@/i18n/core';
import { AuthScreen } from './AuthScreen';
import { useCloudSession, type CloudUser } from './useCloudSession';

function Splash({ label }: { label: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3" aria-busy="true" aria-label={label}>
      <div className="animate-pulse">
        <Logo />
      </div>
      <p className="text-sm text-muted">{label}</p>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 animate-fade-in">
          <Logo />
        </div>
        <div className="card space-y-4 p-6 animate-fade-up">{children}</div>
      </div>
    </div>
  );
}

function ConfigError() {
  return (
    <Centered>
      <h1 className="display flex items-center gap-2 text-xl font-semibold">
        <AlertTriangle className="h-5 w-5 text-negative" aria-hidden /> {t('auth.config.title')}
      </h1>
      <p className="text-sm text-muted">{t('auth.config.text')}</p>
    </Centered>
  );
}

function VerifyError({ message, onRetry }: { message: AuthMessageKey; onRetry: () => void }) {
  return (
    <Centered>
      <h1 className="display text-xl font-semibold">{t('auth.err.verifyFailed')}</h1>
      <p role="alert" className="text-sm text-negative">{t(message)}</p>
      <Button variant="primary" icon={<RefreshCw className="h-4 w-4" aria-hidden />} onClick={onRetry}>
        {t('auth.retry')}
      </Button>
    </Centered>
  );
}

export function CloudHome({ user, onSignOut }: { user: CloudUser; onSignOut: () => Promise<AuthMessageKey | null> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthMessageKey | null>(null);
  async function signOut() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const err = await onSignOut();
    // En cas de succès, l'écran de connexion remplace celui-ci.
    if (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <Centered>
      <h1 className="display flex items-center gap-2 text-xl font-semibold">
        <Cloud className="h-5 w-5 text-cyan" aria-hidden /> {t('cloud.title')}
      </h1>
      <p className="text-sm">{t('cloud.signedInAs', { email: user.email })}</p>
      <p className="text-sm text-muted">{t('cloud.pending')}</p>
      {error && (
        <p role="alert" className="text-sm text-negative">
          {t(error)}
        </p>
      )}
      <Button variant="secondary" loading={busy} icon={<LogOut className="h-4 w-4" aria-hidden />} onClick={signOut}>
        {t('auth.logout')}
      </Button>
    </Centered>
  );
}

/** Barrière d'authentification : seul un état `signedIn` vérifié donne accès à l'espace Cloud. */
export function CloudGate({ auth, timeoutMs }: { auth: AuthPort; timeoutMs?: number }) {
  const { state, retry, signOut } = useCloudSession(auth, timeoutMs);
  switch (state.status) {
    case 'checking':
      return <Splash label={t('auth.checking')} />;
    case 'error':
      return <VerifyError message={state.message} onRetry={retry} />;
    case 'signedOut':
      return <AuthScreen auth={auth} notice={state.notice} timeoutMs={timeoutMs} />;
    case 'signedIn':
      return <CloudHome user={state.user} onSignOut={signOut} />;
  }
}

let reported = false;

/** Point d'entrée du mode Cloud : `auth` est injectable pour les tests. */
export default function CloudApp({ selection = getBackendSelection(), auth }: { selection?: BackendSelection; auth?: AuthPort }) {
  useEffect(() => {
    if (reported || !selection.notices.length) return;
    reported = true;
    for (const n of selection.notices) console.warn(`[NEXORA] ${n}`);
  }, [selection]);
  const port = useMemo<AuthPort | null>(() => {
    if (auth) return auth;
    if (selection.requested !== 'supabase' || selection.supabase.status !== 'ok') return null;
    try {
      return getSupabaseClient(selection).auth;
    } catch {
      return null;
    }
  }, [auth, selection]);
  if (!port) return <ConfigError />;
  return <CloudGate auth={port} />;
}
