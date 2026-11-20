/**
 * Espace Cloud FACTICE pour les tests de la barrière d'authentification et de chargement
 * (`CloudGate`) — RÉSERVÉ AUX TESTS.
 *
 * Avant V3.5, la barrière affichait un écran d'attente (`CloudHome` : titre « Espace Cloud »,
 * adresse, bouton « Se déconnecter » avec état occupé et message d'erreur). Les tests de la
 * barrière (V2.5, V3.4-c) vérifient l'ACCÈS et la DÉCONNEXION, indépendamment du contenu de
 * l'espace : ce composant reproduit à l'identique ce comportement observable. L'application
 * réelle (dépôt, lecteur, onboarding) est couverte par `CloudWorkspace.test.ts`.
 */
import { createElement as h, useState } from 'react';
import { t } from '@/i18n/core';
import type { CloudSessionView } from '@/features/auth/CloudApp';

function StubCloudHome({ user, signOut }: CloudSessionView) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function out() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const err = await signOut();
    if (err) {
      setError(t(err));
      setBusy(false);
    }
  }
  return h(
    'div',
    null,
    h('h1', null, t('cloud.title')),
    h('p', null, t('cloud.signedInAs', { email: user.email })),
    error && h('p', { role: 'alert' }, error),
    h('button', { type: 'button', disabled: busy, onClick: out }, t('auth.logout')),
  );
}

/** Rendu de l'espace pour `CloudGate` (prop `workspace`). */
export const stubWorkspace = (session: CloudSessionView) => h(StubCloudHome, session);
