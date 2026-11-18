// =============================================================================
// NEXORA — contrôles de sécurité par mutation (Lot 0) : définitions.
//
// Chaque mutation AFFAIBLIT volontairement une COPIE de la migration 8
// (`20261101000800_apply_changeset.sql`) ; les suites SQL doivent alors échouer. Une mutation
// non détectée signale un trou dans les tests.
//
// Provenance : portage fidèle du script Python utilisé lors de la qualification du Lot 0
// (session cloud du 14/11/2026, archive `nexora-lot0-outils-hors-depot/mutations/mut.py`).
// Mêmes motifs, mêmes remplacements : la sortie a été vérifiée identique octet par octet à
// celle de l'original pour les 10 mutations (docs/LOT0_QUALIFICATION.md § 5).
//
// Aucune dépendance. Ce module ne lit ni n'écrit aucun fichier : il transforme un texte.
// =============================================================================

const OWNER_CHECK_START = "    -- Propriétaire : la ligne (ou la clé) ne peut désigner que l'utilisateur authentifié.";
const OWNER_CHECK_END = '  end loop;\n\n  -- Phase 2';
const WRITER_SELECT = 'for select to nexora_writer using (user_id = (select private.request_uid()))';
const WRITER_INSERT = 'for insert to nexora_writer with check (user_id = (select private.request_uid()))';
const WRITER_UPDATE = 'for update to nexora_writer using (user_id = (select private.request_uid())) with check (user_id = (select private.request_uid()))';

export class MutationError extends Error {}

/** Remplace la première occurrence (all = true : toutes) ; le motif doit exister. */
function replace(s, from, to, all = false) {
  if (!s.includes(from)) throw new MutationError(`motif introuvable : ${from.slice(0, 60)}`);
  if (all) return s.split(from).join(to);
  const i = s.indexOf(from);
  return s.slice(0, i) + to + s.slice(i + from.length);
}

/** Retire le contrôle du propriétaire de la phase 1 d'apply_changeset. */
function dropOwnerCheck(s) {
  const a = s.indexOf(OWNER_CHECK_START);
  const b = s.indexOf(OWNER_CHECK_END);
  if (a < 0 || b < 0 || b < a) throw new MutationError('bloc du contrôle du propriétaire introuvable');
  return s.slice(0, a) + s.slice(b);
}

function permissiveWriterPolicies(s) {
  s = replace(s, WRITER_SELECT, 'for select to nexora_writer using (true)');
  s = replace(s, WRITER_INSERT, 'for insert to nexora_writer with check (true)');
  return replace(s, WRITER_UPDATE, 'for update to nexora_writer using (true) with check (true)');
}

/** Les 10 mutations. `observed` : échecs relevés sur PostgreSQL 16.15 (référence 1 793) le 14/11/2026. */
export const MUTATIONS = [
  {
    id: 'M1_no_revoke',
    description: 'révocation D4-1 absente : authenticated garde INSERT / UPDATE directs',
    observed: 129,
    apply: (s) => {
      s = replace(s, "    execute format('revoke insert, update on table public.%I from authenticated', t);\n", '');
      return replace(s, 'revoke update on table public.profiles from authenticated;\nrevoke update (display_name) on table public.profiles from authenticated;\n', '');
    },
  },
  {
    id: 'M2_no_owner_check',
    description: 'contrôle du propriétaire retiré de la fonction',
    observed: 46,
    apply: dropOwnerCheck,
  },
  {
    id: 'M3_writer_rls_permissive',
    description: 'politiques RLS du rôle nexora_writer permissives',
    observed: 51,
    apply: permissiveWriterPolicies,
  },
  {
    id: 'M4_no_isolation_in_function',
    description: 'M2 + M3 + filtre du propriétaire retiré des requêtes (isolation supprimée)',
    observed: 164,
    apply: (s) => {
      s = dropOwnerCheck(s);
      s = replace(s, "jsonb_populate_record(null::public.%I, $1)) and %I = $2',", "jsonb_populate_record(null::public.%I, $1)) and (%I = $2 or true)',", true);
      return permissiveWriterPolicies(s);
    },
  },
  {
    id: 'M5_anon_execute',
    description: 'apply_changeset exécutable par anon',
    observed: 4,
    apply: (s) => s + '\ngrant execute on function public.apply_changeset(jsonb) to anon;\n',
  },
  {
    id: 'M6_rls_disabled_one_table',
    description: 'RLS désactivée sur public.transactions',
    observed: 4,
    apply: (s) => s + '\nalter table public.transactions no force row level security;\nalter table public.transactions disable row level security;\n',
  },
  {
    id: 'M7_owner_postgres',
    description: 'fonctions laissées à postgres (propriétaire qui contourne la RLS)',
    observed: 4,
    apply: (s) => replace(s, 'alter function public.apply_changeset(jsonb) owner to nexora_writer;\nalter function public.resolve_changeset(text) owner to nexora_writer;\n', ''),
  },
  {
    id: 'M8_select_all_policy',
    description: 'politique de lecture ouverte sur public.accounts',
    observed: 6,
    apply: (s) => s + '\ncreate policy leak on public.accounts for select to authenticated using (true);\n',
  },
  {
    id: 'M9_public_execute',
    description: 'resolve_changeset exécutable par PUBLIC',
    observed: 7,
    apply: (s) => s + '\ngrant execute on function public.resolve_changeset(text) to public;\n',
  },
  {
    id: 'M10_no_canonical_key',
    description: 'contrôle de clé canonique retiré',
    observed: 7,
    apply: (s) => replace(s, "    if v_canon is distinct from v_op -> 'key' then", '    if false then'),
  },
];

export const MIGRATION_FILE = 'supabase/migrations/20261101000800_apply_changeset.sql';

/** Applique une mutation à un texte ; lève MutationError si un motif manque ou si rien ne change. */
export function mutate(id, sql) {
  const m = MUTATIONS.find((x) => x.id === id);
  if (!m) throw new MutationError(`mutation inconnue : ${id}`);
  const out = m.apply(sql);
  if (out === sql) throw new MutationError(`${id} : la migration n'a pas été modifiée`);
  return out;
}
