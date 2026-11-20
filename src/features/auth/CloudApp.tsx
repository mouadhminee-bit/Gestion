/**
 * Application en mode Cloud (`VITE_DATA_BACKEND=supabase`, V2.5) — chargée à la demande :
 * le mode local ne charge ni ce module ni le SDK Supabase.
 *
 *  - configuration Cloud absente ou invalide → écran bloquant (aucun repli silencieux) ;
 *  - session en cours de vérification → écran d'attente (borné) ;
 *  - aucune session → écrans de connexion / création de compte uniquement ;
 *  - session vérifiée → chargement initial des données Cloud dans le cache de l'utilisateur
 *    (V3.4-c) ; l'espace Cloud n'est accessible qu'une fois ce chargement réussi ; en cas
 *    d'échec : écran d'erreur (« Réessayer », « Se déconnecter », utilisable hors ligne) ;
 *  - chargement réussi → application NEXORA (V3.5) : `CloudRepository(uid, HttpTransport)`
 *    pour les écritures, lecteur du cache (données confirmées uniquement) pour l'affichage ;
 *    nouvel utilisateur → onboarding (`ensureUser` après le chargement).
 *
 * La base locale `nexora` n'est jamais ouverte.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, LogOut, RefreshCw } from 'lucide-react';
import { Logo } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { getBackendSelection, type BackendSelection } from '@/data/backend';
import type { AuthMessageKey, AuthPort } from '@/data/cloud/auth';
import { createCloudDataPort, type CloudDataPort } from '@/data/cloud/cloudLoadCycle';
import { createCloudWorkspacePort, type CloudWorkspace, type CloudWorkspacePort } from '@/data/cloud/cloudWorkspace';
import { HttpReadSource } from '@/data/cloud/HttpReadSource';
import { HttpTransport } from '@/data/cloud/HttpTransport';
import { ErrorBoundary, Workspace } from '@/app/Workspace';
import type { CloudAccount } from '@/app/AppContext';
import { clearUiStateOnSessionEnd } from '@/app/uiState';
import { getSupabaseClient } from '@/data/cloud/supabaseClient';
import { t } from '@/i18n/core';
import { AuthScreen } from './AuthScreen';
import { useCloudData, type CloudLoadMessageKey } from './useCloudData';
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

/** Déconnexion depuis un écran : bouton occupé pendant l'appel, message si elle échoue. */
function useSignOutButton(onSignOut: () => Promise<AuthMessageKey | null>) {
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
  return { busy, error, signOut };
}

/** Échec du chargement initial : aucun accès aux données ; nouvel essai ou déconnexion. */
function LoadError({ message, onRetry, onSignOut }: { message: CloudLoadMessageKey; onRetry: () => void; onSignOut: () => Promise<AuthMessageKey | null> }) {
  const { busy, error, signOut } = useSignOutButton(onSignOut);
  return (
    <Centered>
      <h1 className="display flex items-center gap-2 text-xl font-semibold">
        <AlertTriangle className="h-5 w-5 text-negative" aria-hidden /> {t('cloud.loadError.title')}
      </h1>
      <p role="alert" className="text-sm text-negative">
        {t(message)}
      </p>
      {error && (
        <p role="alert" className="text-sm text-negative">
          {t(error)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<RefreshCw className="h-4 w-4" aria-hidden />} onClick={onRetry}>
          {t('auth.retry')}
        </Button>
        <Button variant="secondary" loading={busy} icon={<LogOut className="h-4 w-4" aria-hidden />} onClick={signOut}>
          {t('auth.logout')}
        </Button>
      </div>
    </Centered>
  );
}

/** Session Cloud prête : utilisateur vérifié et déconnexion. */
export interface CloudSessionView {
  readonly user: CloudUser;
  readonly signOut: () => Promise<AuthMessageKey | null>;
}

/**
 * Application NEXORA de la session (V3.5) : espace de données ouvert pour `user.id` (dépôt
 * d'écriture + lecteur d'affichage), fermé au démontage (fin de session, changement de compte).
 * Créé dans un effet : en mode strict, chaque montage reçoit son propre espace.
 */
export function CloudWorkspaceView({ port, user, signOut }: CloudSessionView & { port: CloudWorkspacePort }) {
  const [space, setSpace] = useState<CloudWorkspace | null>(null);
  useEffect(() => {
    const opened = port.open(user.id);
    setSpace(opened);
    return () => {
      setSpace(null);
      opened.close();
    };
  }, [port, user.id]);
  const account = useMemo<CloudAccount>(() => ({ email: user.email, signOut }), [user.email, signOut]);
  if (!space || space.userId !== user.id) return <Splash label={t('cloud.loading')} />;
  return (
    // Erreur dans l'espace : écran d'erreur propre à cette session (réinitialisé à sa fin).
    <ErrorBoundary>
      <Workspace repo={space.repo} reader={space.reader} cloud={account} />
    </ErrorBoundary>
  );
}

/**
 * Barrière d'authentification et de chargement : seul un état `signedIn` vérifié, dont le
 * chargement initial a RÉUSSI pour ce même utilisateur, donne accès à l'espace Cloud.
 */
export function CloudGate({ auth, cloud, workspace, timeoutMs }: { auth: AuthPort; cloud: CloudDataPort; workspace: (session: CloudSessionView) => ReactNode; timeoutMs?: number }) {
  const { state, retry, signOut } = useCloudSession(auth, timeoutMs);
  const data = useCloudData(state, cloud, auth, timeoutMs);
  // Fin de session ou changement de compte : états d'interface mémorisés effacés (identifiants,
  // filtres, mois), pour qu'aucun ne passe d'un utilisateur à l'autre.
  const uid = state.status === 'signedIn' ? state.user.id : null;
  const lastUid = useRef<string | null>(null);
  useEffect(() => {
    if (state.status === 'signedOut' || (uid && lastUid.current && lastUid.current !== uid)) clearUiStateOnSessionEnd();
    if (uid) lastUid.current = uid;
    else if (state.status === 'signedOut') lastUid.current = null;
  }, [state.status, uid]);
  switch (state.status) {
    case 'checking':
      return <Splash label={t('auth.checking')} />;
    case 'error':
      return <VerifyError message={state.message} onRetry={retry} />;
    case 'signedOut':
      return <AuthScreen auth={auth} notice={state.notice} timeoutMs={timeoutMs} />;
    case 'signedIn': {
      const d = data.state;
      // Clé = utilisateur : un changement de compte démonte entièrement l'espace précédent.
      if (d.status === 'ready' && d.userId === state.user.id) return <Fragment key={state.user.id}>{workspace({ user: state.user, signOut })}</Fragment>;
      if (d.status === 'error' && d.userId === state.user.id) return <LoadError message={d.message} onRetry={data.retry} onSignOut={signOut} />;
      return <Splash label={t('cloud.loading')} />;
    }
  }
}

let reported = false;

/**
 * Point d'entrée du mode Cloud : `auth` et `cloud` sont injectables pour les tests. Sans
 * configuration Cloud valide (ni port injecté), écran bloquant : jamais d'accès sans chargement.
 */
export default function CloudApp({ selection = getBackendSelection(), auth, cloud, workspace }: { selection?: BackendSelection; auth?: AuthPort; cloud?: CloudDataPort; workspace?: CloudWorkspacePort }) {
  useEffect(() => {
    if (reported || !selection.notices.length) return;
    reported = true;
    for (const n of selection.notices) console.warn(`[NEXORA] ${n}`);
  }, [selection]);
  const ports = useMemo<{ auth: AuthPort; cloud: CloudDataPort; workspace: CloudWorkspacePort } | null>(() => {
    let client: ReturnType<typeof getSupabaseClient> | null = null;
    if (selection.requested === 'supabase' && selection.supabase.status === 'ok') {
      try {
        client = getSupabaseClient(selection);
      } catch {
        client = null;
      }
    }
    const authPort = auth ?? client?.auth ?? null;
    const cloudPort = cloud ?? (client ? createCloudDataPort({ source: new HttpReadSource(client) }) : null);
    // Écritures : `HttpTransport` sur le client de l'application (session de l'utilisateur).
    const workspacePort = workspace ?? (client ? createCloudWorkspacePort({ transport: new HttpTransport(client) }) : null);
    return authPort && cloudPort && workspacePort ? { auth: authPort, cloud: cloudPort, workspace: workspacePort } : null;
  }, [auth, cloud, workspace, selection]);
  if (!ports) return <ConfigError />;
  const port = ports.workspace;
  return <CloudGate auth={ports.auth} cloud={ports.cloud} workspace={(session) => <CloudWorkspaceView port={port} {...session} />} />;
}
