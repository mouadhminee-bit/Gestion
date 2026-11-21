/**
 * Client Supabase centralisé (V2.4 ; utilisé depuis V2.5 pour l'AUTHENTIFICATION seule,
 * par `features/auth/CloudApp.tsx`).
 *
 *  - Créé à la demande seulement (jamais à l'import), en un seul exemplaire.
 *  - Construit uniquement à partir de la configuration validée par `getBackendSelection()` :
 *    URL du projet et clé PUBLIQUE (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) ; aucune
 *    clé `service_role`, aucune valeur codée en dur.
 *  - Refusé si le backend demandé n'est pas `supabase` ou si la configuration n'est pas valide.
 *  - La création n'émet aucune requête. Session : mécanismes natifs du SDK (conservation dans
 *    le stockage du navigateur, rafraîchissement automatique).
 *  - Flux PKCE (Plan directeur V1, V3.1 ; V3.7) : le lien de confirmation revient avec `?code=…`
 *    (jamais de jeton dans l'adresse) ; le SDK échange ce code à son initialisation
 *    (`auth.initialize()`), attendue par `CloudBoot` AVANT le montage du `HashRouter`, puis retire
 *    `code` de l'adresse. Le défaut du SDK (flux implicite, `#access_token=…`) est exclu.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getBackendSelection, type BackendSelection } from '../backend';

/** Client Supabase demandé alors que la configuration ne le permet pas. */
export class CloudConfigError extends Error {
  constructor(detail: string) {
    super(`Client Supabase indisponible : ${detail}`);
    this.name = 'CloudConfigError';
  }
}

let client: SupabaseClient | null = null;

/** Client Supabase unique ; lève `CloudConfigError` si le backend ou la configuration ne le permet pas. */
export function getSupabaseClient(selection: BackendSelection = getBackendSelection()): SupabaseClient {
  if (selection.requested !== 'supabase') throw new CloudConfigError('backend « supabase » non sélectionné (VITE_DATA_BACKEND).');
  const status = selection.supabase;
  if (status.status !== 'ok') throw new CloudConfigError(`configuration Cloud ${status.status === 'absent' ? 'absente' : status.status === 'incomplete' ? 'incomplète' : 'invalide'}.`);
  if (!client) client = createClient(status.config.url, status.config.anonKey, { auth: { flowType: 'pkce' } });
  return client;
}

/** Réservé aux tests : oublie le client créé. */
export function resetSupabaseClientForTests(): void {
  client = null;
}
