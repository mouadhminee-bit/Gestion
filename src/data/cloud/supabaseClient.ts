/**
 * Client Supabase centralisé (V2.4 : PRÉPARÉ, NON UTILISÉ par l'application).
 *
 *  - Créé à la demande seulement (jamais à l'import), en un seul exemplaire.
 *  - Construit uniquement à partir de la configuration validée par `getBackendSelection()` :
 *    URL du projet et clé PUBLIQUE (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) ; aucune
 *    clé `service_role`, aucune valeur codée en dur.
 *  - Refusé si le backend demandé n'est pas `supabase` ou si la configuration n'est pas valide.
 *  - La création n'émet aucune requête. Rien dans l'application n'appelle encore ce module :
 *    authentification, lectures et écritures cloud relèvent des phases suivantes
 *    (`CloudRepository` garde `DisabledTransport`).
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
  if (!client) client = createClient(status.config.url, status.config.anonKey);
  return client;
}

/** Réservé aux tests : oublie le client créé. */
export function resetSupabaseClientForTests(): void {
  client = null;
}
