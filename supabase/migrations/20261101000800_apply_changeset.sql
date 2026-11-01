-- =============================================================================
-- NEXORA — Lot 4 / migration 8 : écriture cloud transactionnelle (protocole ChangeSet v1)
--
-- * `public.apply_changeset(jsonb)` : UNIQUE porte d'entrée des écritures métier
--   (décision D4-1). Contrôle optimiste de version (`expectedVersion`), tout ou rien,
--   idempotence par `changesetId`, suppression logique. Contrat : docs/LOT4_PLAN.md § 7.
-- * `public.resolve_changeset(text)` : issue d'un lot dont la confirmation a été perdue
--   (appliqué → résultat d'origine ; inconnu → ABANDONNÉ définitivement).
-- * Rôle dédié `nexora_writer` (NOLOGIN, sans BYPASSRLS) : propriétaire des deux fonctions
--   (SECURITY DEFINER) ; la RLS reste appliquée à l'intérieur par des politiques propres
--   à ce rôle. `authenticated` perd INSERT / UPDATE directs sur les tables métier et
--   conserve SELECT ; il ne peut qu'EXÉCUTER les deux fonctions.
-- * Aucune table `meta` côté serveur ; les migrations 1 à 7 ne sont pas modifiées.
-- * Format filaire : enveloppe du protocole v1 (`src/data/cloud/transport.ts`) dont les
--   tables, clés et lignes sont exprimées en noms SQL par le mapping TS (étape 4.2).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Rôle d'écriture dédié
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'nexora_writer') then
    create role nexora_writer nologin noinherit nobypassrls;
  end if;
end
$$;
-- Le rôle des migrations doit pouvoir lui attribuer la propriété des fonctions.
grant nexora_writer to current_user;

-- -----------------------------------------------------------------------------
-- 2. Utilisateur de la requête (mêmes sources que auth.uid() de Supabase) : évite toute
--    dépendance aux privilèges du schéma auth pour le rôle d'écriture.
-- -----------------------------------------------------------------------------
create function private.request_uid()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

-- -----------------------------------------------------------------------------
-- 3. Liste blanche STATIQUE : tables synchronisées, clé primaire, colonnes écrites par le
--    client. Identique au mapping TS (`src/data/cloud/mapping.ts`, vérifié par test) ;
--    jamais les métadonnées serveur (version, sync_txid, server_updated_at, deleted_at).
-- -----------------------------------------------------------------------------
create table private.changeset_tables (
  sql_table text primary key,
  key_cols text[] not null,
  write_cols text[] not null,
  write_mode text not null check (write_mode in ('upsert', 'update-only'))
);

insert into private.changeset_tables (sql_table, key_cols, write_cols, write_mode) values
  ('profiles', array['id'], array['id', 'display_name'], 'update-only'),
  ('user_settings', array['user_id'], array['user_id', 'display_name', 'base_currency', 'language', 'locale', 'time_zone', 'date_format', 'week_starts_on', 'theme', 'currency_display', 'privacy_mode', 'budget_alert_thresholds', 'notify_budgets', 'notify_bills', 'notify_debts', 'bill_reminder_days', 'onboarded', 'demo_mode', 'updated_at'], 'upsert'),
  ('accounts', array['id'], array['id', 'user_id', 'created_at', 'updated_at', 'name', 'type', 'currency', 'initial_balance', 'initial_balance_date', 'archived', 'include_in_total', 'color', 'description', 'sort_order'], 'upsert'),
  ('categories', array['id'], array['id', 'user_id', 'created_at', 'updated_at', 'name', 'kind', 'nature', 'parent_id', 'icon', 'color', 'archived', 'sort_order', 'key'], 'upsert'),
  ('transactions', array['id'], array['id', 'user_id', 'created_at', 'updated_at', 'type', 'direction', 'amount', 'currency', 'label', 'date', 'category_id', 'subcategory_id', 'account_id', 'payment_method', 'payee', 'notes', 'tags', 'attachment_id', 'status', 'transfer_id', 'counterpart_account_id', 'refund_of_id', 'debt_id', 'debt_payment_id', 'interest_amount', 'recurring_rule_id', 'recurring_due_date', 'import_batch_id'], 'upsert'),
  ('attachments', array['id'], array['id', 'user_id', 'name', 'mime_type', 'size', 'created_at'], 'upsert'),
  ('import_batches', array['id'], array['id', 'user_id', 'file_name', 'created_at', 'row_count', 'imported_count', 'skipped_count', 'account_id'], 'upsert'),
  ('budgets', array['id'], array['id', 'user_id', 'created_at', 'updated_at', 'month', 'category_id', 'amount', 'currency', 'alert_thresholds'], 'upsert'),
  ('savings_goals', array['id'], array['id', 'user_id', 'created_at', 'updated_at', 'name', 'description', 'target_amount', 'currency', 'saved_amount', 'target_date', 'priority', 'linked_account_id', 'track_linked_account', 'monthly_contribution', 'status', 'icon', 'color'], 'upsert'),
  ('goal_contributions', array['id'], array['id', 'user_id', 'goal_id', 'date', 'amount', 'note', 'created_at'], 'upsert'),
  ('recurring_rules', array['id'], array['id', 'user_id', 'created_at', 'updated_at', 'kind', 'label', 'amount', 'currency', 'account_id', 'category_id', 'subcategory_id', 'payee', 'frequency', 'custom_interval', 'custom_unit', 'start_date', 'end_date', 'active', 'notes'], 'upsert'),
  ('recurring_occurrences', array['rule_id', 'due_date'], array['user_id', 'rule_id', 'due_date', 'status', 'transaction_id', 'closure', 'updated_at'], 'upsert'),
  ('debts', array['id'], array['id', 'user_id', 'created_at', 'updated_at', 'label', 'type', 'direction', 'principal', 'currency', 'start_date', 'due_date', 'counterparty', 'interest_rate', 'installment_amount', 'installment_frequency', 'status', 'notes', 'origin_transaction_id'], 'upsert'),
  ('debt_payments', array['id'], array['id', 'user_id', 'debt_id', 'date', 'principal', 'interest', 'account_id', 'transaction_id', 'note', 'created_at'], 'upsert'),
  ('assets', array['id'], array['id', 'user_id', 'created_at', 'updated_at', 'name', 'type', 'currency', 'linked_account_id', 'archived', 'notes'], 'upsert'),
  ('asset_valuations', array['id'], array['id', 'user_id', 'asset_id', 'date', 'value', 'source', 'note', 'created_at'], 'upsert'),
  ('exchange_rates', array['id'], array['id', 'user_id', 'base', 'quote', 'rate', 'date', 'source', 'created_at'], 'upsert'),
  ('notification_states', array['user_id', 'id'], array['id', 'user_id', 'read', 'dismissed', 'updated_at'], 'upsert');

-- -----------------------------------------------------------------------------
-- 4. Suivi des lots (idempotence, abandon). Aucune donnée métier : empreinte du lot et
--    confirmation (tables, clés, versions) seulement.
-- -----------------------------------------------------------------------------
create table private.changesets (
  user_id uuid not null references auth.users (id) on delete cascade,
  changeset_id uuid not null,
  status text not null check (status in ('applied', 'abandoned')),
  fingerprint bytea,                -- sha256 du lot reçu (forme jsonb canonique)
  op_count integer,
  result jsonb,                     -- confirmation renvoyée (status 'applied')
  created_at timestamptz not null default now(),
  primary key (user_id, changeset_id),
  constraint changesets_applied_complete check (
    (status = 'applied' and fingerprint is not null and result is not null and op_count is not null)
    or (status = 'abandoned' and fingerprint is null and result is null and op_count is null)
  )
);
alter table private.changesets enable row level security;
alter table private.changesets force row level security;

-- -----------------------------------------------------------------------------
-- 5. Erreurs du protocole. SQLSTATE « PTxxx » : PostgREST renvoie le statut HTTP xxx ;
--    message = code du protocole ; detail = JSON sans donnée d'un autre utilisateur.
-- -----------------------------------------------------------------------------
create function private.changeset_error(p_code text, p_detail jsonb default null)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_state text := case p_code
    when 'unauthorized' then 'PT403'
    when 'changeset_too_large' then 'PT413'
    when 'version_conflict' then 'PT409'
    when 'duplicate_key' then 'PT409'
    when 'changeset_id_reused' then 'PT409'
    when 'changeset_abandoned' then 'PT409'
    when 'changeset_pending' then 'PT409'
    else 'PT400' -- unsupported_protocol, invalid_changeset, unsupported_table, invalid_operation, invalid_key, invalid_row
  end;
begin
  raise exception using errcode = v_state, message = p_code, detail = coalesce(p_detail, '{}'::jsonb)::text;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. apply_changeset
-- -----------------------------------------------------------------------------
create function public.apply_changeset(p_changeset jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- D4-6 : limites fixées par mesure (docs/LOT4_PLAN.md § 7.8).
  c_max_ops constant integer := 5000;
  c_max_bytes constant integer := 4194304; -- 4 Mio de JSON
  c_meta constant text[] := array['version', 'sync_txid', 'server_updated_at', 'deleted_at'];
  v_uid uuid;
  v_id uuid;
  v_fp bytea;
  v_prev private.changesets%rowtype;
  v_ops jsonb;
  v_n integer;
  v_op jsonb;
  v_i integer;
  v_pos integer := -1;                   -- opération en cours (la variable de boucle est locale)
  v_spec private.changeset_tables%rowtype;
  v_specs jsonb := '{}'::jsonb;          -- table → spécification (cache)
  v_cols text[];
  v_type text;
  v_exp jsonb;
  v_expected bigint;
  v_cur_version bigint;
  v_cur_deleted boolean;
  -- Tableaux PL/pgSQL (ajout en place, coût linéaire) plutôt que des concaténations jsonb.
  v_exists boolean[] := '{}';            -- par opération : la ligne existe-t-elle déjà ?
  v_conflicts jsonb[] := '{}';
  v_versions jsonb[] := '{}';
  v_new_version bigint;
  v_where text;
  v_owner_col text;
  v_result jsonb;
  v_sqlstate text;
  v_constraint text;
begin
  -- Utilisateur authentifié (jamais celui annoncé par le client).
  begin
    v_uid := private.request_uid();
  exception when others then
    v_uid := null;
  end;
  if v_uid is null then
    perform private.changeset_error('unauthorized', jsonb_build_object('reason', 'authentification requise'));
  end if;

  -- Enveloppe.
  if p_changeset is null or jsonb_typeof(p_changeset) <> 'object' then
    perform private.changeset_error('invalid_changeset', jsonb_build_object('reason', 'objet attendu'));
  end if;
  if octet_length(p_changeset::text) > c_max_bytes then
    perform private.changeset_error('changeset_too_large', jsonb_build_object('maxBytes', c_max_bytes));
  end if;
  if exists (select 1 from jsonb_object_keys(p_changeset) k where k not in ('protocol', 'changesetId', 'userId', 'ops'))
     or not (p_changeset ?& array['protocol', 'changesetId', 'userId', 'ops']) then
    perform private.changeset_error('invalid_changeset', jsonb_build_object('reason', 'champs attendus : protocol, changesetId, userId, ops'));
  end if;
  if p_changeset -> 'protocol' is distinct from '1'::jsonb then
    perform private.changeset_error('unsupported_protocol', jsonb_build_object('supported', jsonb_build_array(1)));
  end if;
  if jsonb_typeof(p_changeset -> 'changesetId') <> 'string'
     or (p_changeset ->> 'changesetId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform private.changeset_error('invalid_changeset', jsonb_build_object('reason', 'changesetId : UUID attendu'));
  end if;
  v_id := (p_changeset ->> 'changesetId')::uuid;
  if jsonb_typeof(p_changeset -> 'userId') <> 'string' or (p_changeset ->> 'userId') <> v_uid::text then
    perform private.changeset_error('unauthorized', jsonb_build_object('reason', 'userId différent de l’utilisateur authentifié'));
  end if;
  v_ops := p_changeset -> 'ops';
  if jsonb_typeof(v_ops) <> 'array' or jsonb_array_length(v_ops) = 0 then
    perform private.changeset_error('invalid_changeset', jsonb_build_object('reason', 'ops : tableau non vide attendu'));
  end if;
  v_n := jsonb_array_length(v_ops);
  if v_n > c_max_ops then
    perform private.changeset_error('changeset_too_large', jsonb_build_object('maxOps', c_max_ops, 'ops', v_n));
  end if;

  -- Sérialisation par utilisateur : un seul lot (ou une seule résolution) à la fois pour un
  -- même utilisateur, tous appareils confondus. Rend sûrs les créations concurrentes d'une
  -- même clé, les soumissions concurrentes d'un même changesetId et l'ordre des verrous.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('nexora.changeset:' || v_uid::text, 0));

  -- Idempotence (avant toute validation métier : un rejeu renvoie le résultat d'origine).
  v_fp := pg_catalog.sha256(pg_catalog.convert_to(p_changeset::text, 'UTF8'));
  select * into v_prev from private.changesets where user_id = v_uid and changeset_id = v_id;
  if found then
    if v_prev.status = 'abandoned' then
      perform private.changeset_error('changeset_abandoned', jsonb_build_object('changesetId', v_id));
    elsif v_prev.fingerprint <> v_fp then
      perform private.changeset_error('changeset_id_reused', jsonb_build_object('changesetId', v_id));
    end if;
    return v_prev.result || jsonb_build_object('status', 'replayed');
  end if;

  -- Phase 1 : forme de chaque opération (aucune lecture ni écriture métier).
  if exists (select 1 from jsonb_array_elements(v_ops) e
             where jsonb_typeof(e) = 'object'
             group by e -> 'table', e -> 'key' having count(*) > 1) then
    perform private.changeset_error('invalid_changeset', jsonb_build_object('reason', 'deux opérations sur la même clé'));
  end if;
  for v_i in 0 .. v_n - 1 loop
    v_op := v_ops -> v_i;
    if jsonb_typeof(v_op) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_op) k where k not in ('table', 'type', 'key', 'expectedVersion', 'row'))
       or not (v_op ?& array['table', 'type', 'key', 'expectedVersion']) then
      perform private.changeset_error('invalid_operation', jsonb_build_object('op', v_i, 'reason', 'champs attendus : table, type, key, expectedVersion[, row]'));
    end if;
    if jsonb_typeof(v_op -> 'table') <> 'string' then
      perform private.changeset_error('unsupported_table', jsonb_build_object('op', v_i));
    end if;
    if not (v_specs ? (v_op ->> 'table')) then
      select * into v_spec from private.changeset_tables where sql_table = v_op ->> 'table';
      if not found then
        perform private.changeset_error('unsupported_table', jsonb_build_object('op', v_i, 'table', left(v_op ->> 'table', 64)));
      end if;
      v_specs := v_specs || jsonb_build_object(v_spec.sql_table, to_jsonb(v_spec));
    end if;
    select * into v_spec from jsonb_populate_record(null::private.changeset_tables, v_specs -> (v_op ->> 'table'));
    v_type := v_op ->> 'type';
    if jsonb_typeof(v_op -> 'type') <> 'string' or v_type not in ('put', 'delete') then
      perform private.changeset_error('invalid_operation', jsonb_build_object('op', v_i, 'reason', 'type : put ou delete'));
    end if;
    v_exp := v_op -> 'expectedVersion';
    if not (jsonb_typeof(v_exp) = 'null'
            or (jsonb_typeof(v_exp) = 'number' and (v_exp::text)::numeric = trunc((v_exp::text)::numeric)
                and (v_exp::text)::numeric between 1 and 9007199254740991)) then
      perform private.changeset_error('invalid_operation', jsonb_build_object('op', v_i, 'reason', 'expectedVersion : entier ≥ 1 ou null'));
    end if;
    -- Clé : exactement les colonnes de la clé primaire, valeurs scalaires non nulles.
    if jsonb_typeof(v_op -> 'key') <> 'object'
       or (select array_agg(k order by k) from jsonb_object_keys(v_op -> 'key') k) is distinct from (select array_agg(k order by k) from unnest(v_spec.key_cols) k)
       or exists (select 1 from jsonb_each(v_op -> 'key') e where jsonb_typeof(e.value) not in ('string', 'number')) then
      perform private.changeset_error('invalid_key', jsonb_build_object('op', v_i, 'table', v_spec.sql_table, 'expected', to_jsonb(v_spec.key_cols)));
    end if;
    if v_type = 'delete' then
      if v_op ? 'row' then
        perform private.changeset_error('invalid_operation', jsonb_build_object('op', v_i, 'reason', 'une suppression ne transporte pas de ligne'));
      end if;
      if v_spec.write_mode = 'update-only' then
        perform private.changeset_error('invalid_operation', jsonb_build_object('op', v_i, 'reason', 'suppression interdite pour cette table'));
      end if;
    else
      if jsonb_typeof(v_op -> 'row') is distinct from 'object' then
        perform private.changeset_error('invalid_row', jsonb_build_object('op', v_i, 'reason', 'ligne attendue'));
      end if;
      select array_agg(k) into v_cols from jsonb_object_keys(v_op -> 'row') k where k = any (c_meta);
      if v_cols is not null then
        perform private.changeset_error('invalid_row', jsonb_build_object('op', v_i, 'reason', 'métadonnées serveur interdites', 'columns', to_jsonb(v_cols)));
      end if;
      if (select array_agg(k order by k) from jsonb_object_keys(v_op -> 'row') k) is distinct from (select array_agg(k order by k) from unnest(v_spec.write_cols) k) then
        perform private.changeset_error('invalid_row', jsonb_build_object('op', v_i, 'table', v_spec.sql_table, 'reason', 'colonnes attendues', 'expected', to_jsonb(v_spec.write_cols)));
      end if;
      if exists (select 1 from unnest(v_spec.key_cols) k where (v_op -> 'row' -> k) is distinct from (v_op -> 'key' -> k)) then
        perform private.changeset_error('invalid_key', jsonb_build_object('op', v_i, 'reason', 'clé incohérente avec la ligne'));
      end if;
    end if;
    -- Propriétaire : la ligne (ou la clé) ne peut désigner que l'utilisateur authentifié.
    v_owner_col := case when v_spec.sql_table = 'profiles' then 'id' else 'user_id' end;
    if (v_op -> 'key' ? v_owner_col and (v_op -> 'key' ->> v_owner_col) is distinct from v_uid::text)
       or (v_type = 'put' and (v_op -> 'row' ->> v_owner_col) is distinct from v_uid::text) then
      perform private.changeset_error('unauthorized', jsonb_build_object('op', v_i, 'reason', 'ligne attribuée à un autre utilisateur'));
    end if;
  end loop;

  -- Phase 2 : TOUTES les versions vérifiées (lignes verrouillées) avant la moindre écriture.
  for v_i in 0 .. v_n - 1 loop
    v_op := v_ops -> v_i;
    select * into v_spec from jsonb_populate_record(null::private.changeset_tables, v_specs -> (v_op ->> 'table'));
    v_owner_col := case when v_spec.sql_table = 'profiles' then 'id' else 'user_id' end;
    v_where := format('(%s) = (select %s from jsonb_populate_record(null::public.%I, $1)) and %I = $2',
      (select string_agg(format('t.%I', k), ', ') from unnest(v_spec.key_cols) k),
      (select string_agg(format('%I', k), ', ') from unnest(v_spec.key_cols) k),
      v_spec.sql_table, v_owner_col);
    begin
      execute format('select t.version, t.deleted_at is not null from public.%I t where %s for update', v_spec.sql_table, v_where)
        into v_cur_version, v_cur_deleted
        using v_op -> 'key', v_uid;
    exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
      perform private.changeset_error('invalid_key', jsonb_build_object('op', v_i, 'table', v_spec.sql_table, 'reason', 'valeur de clé invalide'));
    end;
    v_expected := case when jsonb_typeof(v_op -> 'expectedVersion') = 'null' then null else (v_op ->> 'expectedVersion')::bigint end;
    if not (case
      when v_op ->> 'type' = 'put' and v_expected is null then v_cur_version is null
      when v_op ->> 'type' = 'put' then v_cur_version is not distinct from v_expected
      else v_expected is not null and v_cur_version is not distinct from v_expected and not v_cur_deleted
    end) then
      v_conflicts := array_append(v_conflicts, jsonb_build_object(
        'table', v_spec.sql_table, 'key', v_op -> 'key', 'expectedVersion', v_op -> 'expectedVersion',
        'actualVersion', v_cur_version, 'actualDeleted', v_cur_deleted));
    end if;
    v_exists := array_append(v_exists, v_cur_version is not null);
    v_cur_version := null;
    v_cur_deleted := null;
  end loop;
  if cardinality(v_conflicts) > 0 then
    perform private.changeset_error('version_conflict', jsonb_build_object('conflicts', to_jsonb(v_conflicts)));
  end if;

  -- Phase 3 : écritures, dans l'ordre du lot. Toute erreur annule le lot entier.
  begin
    for v_i in 0 .. v_n - 1 loop
      v_pos := v_i;
      v_op := v_ops -> v_i;
      select * into v_spec from jsonb_populate_record(null::private.changeset_tables, v_specs -> (v_op ->> 'table'));
      v_owner_col := case when v_spec.sql_table = 'profiles' then 'id' else 'user_id' end;
      v_where := format('(%s) = (select %s from jsonb_populate_record(null::public.%I, $1)) and %I = $2',
        (select string_agg(format('%I', k), ', ') from unnest(v_spec.key_cols) k),
        (select string_agg(format('%I', k), ', ') from unnest(v_spec.key_cols) k),
        v_spec.sql_table, v_owner_col);
      if v_op ->> 'type' = 'delete' then
        -- Suppression logique : le déclencheur horodate deleted_at (now()) et incrémente la version.
        execute format('update public.%I set deleted_at = now() where %s returning version', v_spec.sql_table, v_where)
          into v_new_version using v_op -> 'key', v_uid;
      elsif not v_exists[v_i + 1] then
        if v_spec.write_mode = 'update-only' then
          perform private.changeset_error('invalid_operation', jsonb_build_object('op', v_i, 'reason', 'création interdite pour cette table'));
        end if;
        v_cols := v_spec.write_cols;
        execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1) returning version',
          v_spec.sql_table,
          (select string_agg(format('%I', c), ', ') from unnest(v_cols) c),
          (select string_agg(format('%I', c), ', ') from unnest(v_cols) c),
          v_spec.sql_table)
          into v_new_version using v_op -> 'row';
      else
        -- Modification ou réactivation : colonnes écrites (hors clé) ; deleted_at remis à null.
        select array_agg(c) into v_cols from unnest(v_spec.write_cols) c where c <> all (v_spec.key_cols);
        execute format('update public.%I set (%s) = (select %s from jsonb_populate_record(null::public.%I, $3))%s where %s returning version',
          v_spec.sql_table,
          (select string_agg(format('%I', c), ', ') from unnest(v_cols) c),
          (select string_agg(format('%I', c), ', ') from unnest(v_cols) c),
          v_spec.sql_table,
          case when v_spec.write_mode = 'upsert' then ', deleted_at = null' else '' end,
          v_where)
          into v_new_version using v_op -> 'key', v_uid, v_op -> 'row';
      end if;
      v_versions := array_append(v_versions, jsonb_build_object(
        'table', v_spec.sql_table, 'key', v_op -> 'key', 'version', v_new_version, 'deleted', v_op ->> 'type' = 'delete'));
    end loop;
  exception
    when sqlstate 'PT400' or sqlstate 'PT403' or sqlstate 'PT409' or sqlstate 'PT413' then
      raise;
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      -- Clé primaire déjà prise par une ligne invisible (autre utilisateur) : rien d'autre n'est révélé.
      perform private.changeset_error('duplicate_key', jsonb_build_object('op', v_pos, 'table', v_spec.sql_table));
    when others then
      get stacked diagnostics v_sqlstate = returned_sqlstate, v_constraint = constraint_name;
      perform private.changeset_error('invalid_row', jsonb_build_object(
        'op', v_pos, 'table', v_spec.sql_table, 'sqlstate', v_sqlstate, 'constraint', nullif(v_constraint, '')));
  end;

  v_result := jsonb_build_object('changesetId', v_id, 'versions', to_jsonb(v_versions));
  insert into private.changesets (user_id, changeset_id, status, fingerprint, op_count, result)
  values (v_uid, v_id, 'applied', v_fp, v_n, v_result);
  return v_result || jsonb_build_object('status', 'applied');
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. resolve_changeset
-- -----------------------------------------------------------------------------
create function public.resolve_changeset(p_changeset_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_id uuid;
  v_prev private.changesets%rowtype;
begin
  begin
    v_uid := private.request_uid();
  exception when others then
    v_uid := null;
  end;
  if v_uid is null then
    perform private.changeset_error('unauthorized', jsonb_build_object('reason', 'authentification requise'));
  end if;
  if p_changeset_id is null or p_changeset_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform private.changeset_error('invalid_changeset', jsonb_build_object('reason', 'changesetId : UUID attendu'));
  end if;
  v_id := p_changeset_id::uuid;
  -- Même verrou que apply_changeset : attend la fin d'un lot en cours ; au-delà de 5 s,
  -- l'issue n'est pas encore déterminée (changeset_pending) et rien n'est modifié.
  perform pg_catalog.set_config('lock_timeout', '5s', true);
  begin
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('nexora.changeset:' || v_uid::text, 0));
  exception when lock_not_available then
    perform private.changeset_error('changeset_pending', jsonb_build_object('changesetId', v_id));
  end;
  perform pg_catalog.set_config('lock_timeout', '0', true);
  select * into v_prev from private.changesets where user_id = v_uid and changeset_id = v_id;
  if found and v_prev.status = 'applied' then
    return v_prev.result || jsonb_build_object('status', 'replayed');
  elsif found then
    return jsonb_build_object('changesetId', v_id, 'status', 'abandoned');
  end if;
  insert into private.changesets (user_id, changeset_id, status) values (v_uid, v_id, 'abandoned');
  return jsonb_build_object('changesetId', v_id, 'status', 'abandoned');
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Privilèges
-- -----------------------------------------------------------------------------
-- Fonctions internes : exécutables par le rôle d'écriture seulement.
revoke all on function private.request_uid() from public, anon, authenticated;
revoke all on function private.changeset_error(text, jsonb) from public, anon, authenticated;
grant usage on schema private to nexora_writer;
grant execute on function private.request_uid() to nexora_writer;
grant execute on function private.changeset_error(text, jsonb) to nexora_writer;

-- Métadonnées et suivi des lots : jamais accessibles aux rôles applicatifs.
revoke all on table private.changeset_tables from public, anon, authenticated;
revoke all on table private.changesets from public, anon, authenticated;
grant select on table private.changeset_tables to nexora_writer;
grant select, insert on table private.changesets to nexora_writer;
create policy changesets_writer_select on private.changesets for select to nexora_writer
  using (user_id = (select private.request_uid()));
create policy changesets_writer_insert on private.changesets for insert to nexora_writer
  with check (user_id = (select private.request_uid()));

-- Tables métier : le rôle d'écriture lit, insère et modifie les seules lignes de
-- l'utilisateur de la requête (RLS forcée : appliquée aussi à l'intérieur des fonctions).
do $$
declare
  t text;
begin
  foreach t in array array[
    'user_settings', 'accounts', 'categories', 'import_batches', 'transactions', 'attachments',
    'budgets', 'savings_goals', 'goal_contributions', 'recurring_rules', 'recurring_occurrences',
    'debts', 'debt_payments', 'assets', 'asset_valuations', 'exchange_rates', 'notification_states'
  ] loop
    execute format('grant select, insert, update on table public.%I to nexora_writer', t);
    execute format('create policy %I on public.%I for select to nexora_writer using (user_id = (select private.request_uid()))', t || '_writer_select', t);
    execute format('create policy %I on public.%I for insert to nexora_writer with check (user_id = (select private.request_uid()))', t || '_writer_insert', t);
    execute format('create policy %I on public.%I for update to nexora_writer using (user_id = (select private.request_uid())) with check (user_id = (select private.request_uid()))', t || '_writer_update', t);
    -- D4-1 : plus aucune écriture directe pour authenticated (lecture conservée).
    execute format('revoke insert, update on table public.%I from authenticated', t);
  end loop;
end
$$;
grant select on table public.profiles to nexora_writer;
grant update (display_name) on table public.profiles to nexora_writer;
create policy profiles_writer_select on public.profiles for select to nexora_writer
  using (id = (select private.request_uid()));
create policy profiles_writer_update on public.profiles for update to nexora_writer
  using (id = (select private.request_uid())) with check (id = (select private.request_uid()));
revoke update on table public.profiles from authenticated;
revoke update (display_name) on table public.profiles from authenticated;

-- Fonctions publiques : propriété du rôle d'écriture ; exécution par authenticated seulement.
-- (ALTER OWNER exige le privilège CREATE du nouveau propriétaire sur le schéma : accordé le
-- temps du transfert, puis retiré.)
grant create on schema public to nexora_writer;
alter function public.apply_changeset(jsonb) owner to nexora_writer;
alter function public.resolve_changeset(text) owner to nexora_writer;
revoke create on schema public from nexora_writer;
revoke all on function public.apply_changeset(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.resolve_changeset(text) from public, anon, authenticated, service_role;
grant execute on function public.apply_changeset(jsonb) to authenticated;
grant execute on function public.resolve_changeset(text) to authenticated;
