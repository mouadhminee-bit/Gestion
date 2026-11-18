/**
 * Écrans de connexion et de création de compte (mode Cloud, V2.5).
 *
 * Une seule requête à la fois (bouton désactivé et garde contre la double soumission),
 * chaque requête bornée par un délai, messages d'erreur traduits. Le mot de passe n'est
 * jamais journalisé ni conservé après la requête. Si la confirmation d'e-mail est exigée,
 * l'inscription affiche la marche à suivre ; la connexion se fait ensuite normalement.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LogIn, MailCheck, UserPlus } from 'lucide-react';
import { Logo } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { LanguageSelect } from '@/components/ui/LanguageSelect';
import { authMessageKey, checkCredentials, withTimeout, type AuthMessageKey, type AuthPort } from '@/data/cloud/auth';
import { t } from '@/i18n/core';

type Mode = 'login' | 'signup';

/** Adresse de retour après confirmation d'e-mail : l'application elle-même. */
function confirmationRedirect(): string | undefined {
  try {
    return `${window.location.origin}${window.location.pathname}`;
  } catch {
    return undefined;
  }
}

export function AuthScreen({ auth, notice, timeoutMs }: { auth: AuthPort; notice?: AuthMessageKey; timeoutMs?: number }) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthMessageKey | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function switchMode(next: Mode) {
    if (inFlight.current) return;
    setMode(next);
    setError(null);
    setSentTo(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const invalid = checkCredentials(email, password);
    if (invalid) return setError(invalid);
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setSentTo(null);
    const address = email.trim();
    try {
      if (mode === 'login') {
        const { error: err } = await withTimeout(auth.signInWithPassword({ email: address, password }), timeoutMs);
        if (err) throw err;
        // Succès : l'événement SIGNED_IN du SDK ouvre l'application.
      } else {
        const { data, error: err } = await withTimeout(auth.signUp({ email: address, password, options: { emailRedirectTo: confirmationRedirect() } }), timeoutMs);
        if (err) throw err;
        if (!data.session) {
          // Confirmation d'e-mail exigée (ou adresse déjà inscrite : réponse volontairement identique).
          setSentTo(address);
          setMode('login');
        }
      }
      setPassword('');
    } catch (err) {
      setError(authMessageKey(err));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const login = mode === 'login';
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-3 animate-fade-in">
          <Logo />
          <LanguageSelect className="w-[200px]" />
        </div>
        <form className="card space-y-4 p-6 animate-fade-up" onSubmit={submit} noValidate aria-busy={busy}>
          <div>
            <h1 className="display text-xl font-semibold">{t(login ? 'auth.title.login' : 'auth.title.signup')}</h1>
            <p className="mt-1 text-sm text-muted">{t('auth.subtitle')}</p>
          </div>
          {notice && !error && !sentTo && (
            <p role="status" className="rounded-xl border border-line/15 bg-surface-2/60 p-3 text-sm">{t(notice)}</p>
          )}
          {sentTo && (
            <p role="status" className="flex gap-2 rounded-xl border border-primary/30 bg-primary/10 p-3 text-sm">
              <MailCheck className="mt-0.5 h-4 w-4 shrink-0 text-cyan" aria-hidden />
              <span>{t('auth.confirmSent', { email: sentTo })}</span>
            </p>
          )}
          <Field label={t('auth.email')} htmlFor="auth-email">
            <Input id="auth-email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} invalid={error === 'auth.err.emailInvalid'} autoFocus />
          </Field>
          <Field label={t('auth.password')} htmlFor="auth-password">
            <Input id="auth-password" type="password" autoComplete={login ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          </Field>
          {error && (
            <p role="alert" className="text-sm text-negative">
              {t(error)}
            </p>
          )}
          <Button type="submit" variant="primary" className="w-full" loading={busy} icon={login ? <LogIn className="h-4 w-4" aria-hidden /> : <UserPlus className="h-4 w-4" aria-hidden />}>
            {t(login ? 'auth.login' : 'auth.signup')}
          </Button>
          <button type="button" className="w-full text-center text-sm text-primary hover:underline disabled:opacity-50" onClick={() => switchMode(login ? 'signup' : 'login')} disabled={busy}>
            {t(login ? 'auth.toSignup' : 'auth.toLogin')}
          </button>
        </form>
      </div>
    </div>
  );
}
