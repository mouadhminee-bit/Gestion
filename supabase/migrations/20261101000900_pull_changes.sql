-- =============================================================================
-- NEXORA — Plan directeur V1, V4.1 / migration 9 : récupération des changements (M9, P28)
--
-- * `public.pull_changes(p_cursor, p_bound, p_after, p_limit)` : lignes de l'utilisateur
--   authentifié, sur les 18 tables synchronisées, ACTIVES ET SUPPRIMÉES (`deleted_at`
--   renseigné), dont `p_cursor ≤ sync_txid < borne`.
-- * Borne sûre (D3-2, docs/LOT3_PLAN.md § 7 ; P8) : `pg_snapshot_xmin(pg_current_snapshot())`
--   au premier appel. Toute transaction d'identifiant inférieur est terminée : aucune écriture
--   encore en cours ne peut apparaître plus tard SOUS la borne, qui devient le curseur suivant.
--   Une transaction longue retarde la borne (P8 : retard, jamais de perte).
-- * Pagination stable dans l'intervalle FIXE [curseur, borne) : tri (sync_txid, table, clé)
--   en collation « C », pages de `p_limit` lignes (1 à 1 000), reprise après `p_after`
--   (position renvoyée par la page précédente dans `next`). Une ligne modifiée pendant la
--   pagination reçoit un `sync_txid` ≥ borne : elle sort de l'intervalle et sera renvoyée,
--   dans sa dernière version, par la récupération suivante (aucune perte).
-- * `xid8` transmis en TEXTE (`bound`, `next.txid`, `row.sync_txid`) : aucune perte de
--   précision côté JavaScript.
-- * SECURITY INVOKER (A3) : exécutée avec les droits de `authenticated` ; la RLS existante
--   (migration 6 : `user_id = auth.uid()`, `id` pour les profils) s'applique ; le filtre
--   explicite sur l'utilisateur ne sert qu'aux index `(user_id, sync_txid)`.
-- * Lecture seule : aucune écriture, aucun accès au schéma `private`.
-- * Les migrations 1 à 8 ne sont pas modifiées.
--
-- Réponse : { "bound": "<xid8>", "rows": [ { "table", "key", "row" } … ], "next": null |
--   { "txid", "table", "key" } }. `next` nul : intervalle épuisé, le nouveau curseur est
--   `bound`. Sinon : rappeler avec le même curseur, `p_bound = bound` et `p_after = next`.
-- Erreurs : PT403 `unauthorized` (aucun utilisateur) ; PT400 `invalid_pull` (paramètre
--   invalide, détail dans `details`).
-- =============================================================================

create function public.pull_changes(
  p_cursor text default '0',
  p_bound text default null,
  p_after jsonb default null,
  p_limit integer default 1000
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  c_max_limit constant integer := 1000;
  v_uid uuid := auth.uid();
  v_xmin xid8 := pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot());
  v_cursor xid8;
  v_bound xid8;
  a_txid xid8;
  a_table text;
  a_key text;
  v_sql text := '';
  v_rows jsonb;
  v_more boolean;
  v_last jsonb;
  t record;
begin
  if v_uid is null then
    raise exception using errcode = 'PT403', message = 'unauthorized', detail = '{"reason": "authentification requise"}';
  end if;

  -- Paramètres : entiers xid8 en texte décimal, intervalle cohérent, borne jamais future.
  if p_cursor is null or p_cursor !~ '^[0-9]{1,20}$' then
    raise exception using errcode = 'PT400', message = 'invalid_pull', detail = '{"reason": "p_cursor : entier xid8 en texte attendu"}';
  end if;
  v_cursor := p_cursor::xid8;
  if p_bound is null then
    if p_after is not null then
      raise exception using errcode = 'PT400', message = 'invalid_pull', detail = '{"reason": "p_after exige p_bound (page suivante d''un même intervalle)"}';
    end if;
    v_bound := v_xmin;
  else
    if p_bound !~ '^[0-9]{1,20}$' then
      raise exception using errcode = 'PT400', message = 'invalid_pull', detail = '{"reason": "p_bound : entier xid8 en texte attendu"}';
    end if;
    v_bound := p_bound::xid8;
    if v_bound > v_xmin then
      raise exception using errcode = 'PT400', message = 'invalid_pull', detail = '{"reason": "p_bound : borne postérieure à la borne sûre actuelle"}';
    end if;
  end if;
  if v_cursor > v_bound then
    raise exception using errcode = 'PT400', message = 'invalid_pull', detail = '{"reason": "p_cursor supérieur à la borne"}';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > c_max_limit then
    raise exception using errcode = 'PT400', message = 'invalid_pull', detail = '{"reason": "p_limit : entier de 1 à 1000 attendu"}';
  end if;
  if p_after is not null then
    -- Contrôles en deux temps : `jsonb_object_keys` n'est appelé que sur un objet.
    if pg_catalog.jsonb_typeof(p_after) <> 'object' then
      raise exception using errcode = 'PT400', message = 'invalid_pull', detail = '{"reason": "p_after : { txid, table, key } attendu (valeur de next)"}';
    end if;
    if exists (select 1 from pg_catalog.jsonb_object_keys(p_after) k where k not in ('txid', 'table', 'key'))
       or pg_catalog.jsonb_typeof(p_after -> 'txid') is distinct from 'string'
       or pg_catalog.jsonb_typeof(p_after -> 'table') is distinct from 'string'
       or pg_catalog.jsonb_typeof(p_after -> 'key') is distinct from 'string'
       or (p_after ->> 'txid') !~ '^[0-9]{1,20}$' then
      raise exception using errcode = 'PT400', message = 'invalid_pull', detail = '{"reason": "p_after : { txid, table, key } attendu (valeur de next)"}';
    end if;
    a_txid := (p_after ->> 'txid')::xid8;
    a_table := p_after ->> 'table';
    a_key := p_after ->> 'key';
    if a_txid < v_cursor or a_txid >= v_bound then
      raise exception using errcode = 'PT400', message = 'invalid_pull', detail = '{"reason": "p_after hors de l''intervalle [p_cursor, p_bound)"}';
    end if;
  end if;

  -- 18 tables : propriétaire, clé SQL (comme la liste blanche de la migration 8) et clé de
  -- tri textuelle (unique par utilisateur).
  for t in
    select * from (values
      ('profiles',              'id',      $k$pg_catalog.jsonb_build_object('id', x.id)$k$,                                  $s$x.id::text$s$),
      ('user_settings',         'user_id', $k$pg_catalog.jsonb_build_object('user_id', x.user_id)$k$,                        $s$x.user_id::text$s$),
      ('accounts',              'user_id', $k$pg_catalog.jsonb_build_object('id', x.id)$k$,                                  $s$x.id::text$s$),
      ('categories',            'user_id', $k$pg_catalog.jsonb_build_object('id', x.id)$k$,                                  $s$x.id::text$s$),
      ('import_batches',        'user_id', $k$pg_catalog.jsonb_build_object('id', x.id)$k$,                                  $s$x.id::text$s$),
      ('transactions',          'user_id', $k$pg_catalog.jsonb_build_object('id', x.id)$k$,                                  $s$x.id::text$s$),
      ('attachments',           'user_id', $k$pg_catalog.jsonb_build_object('id', x.id)$k$,                                  $s$x.id::text$s$),
      ('budgets',               'user_id', $k$pg_catalog.jsonb_build_object('id', x.id)$k$,                                  $s$x.id::text$s$),
      ('savings_goals',         'user_id', $k$pg_catalog.jsonb_build_object('id', x.id)$k$,                                  $s$x.id::text$s$),
      ('goal_contributions',    'user_id', $k$pg_catalog.jsonb_build_object('id', x.id)$k$,                                  $s$x.id::text$s$),
      ('recurring_rules',       'user_id', $k$pg_catalog.jsonb_build_object('id', x.id)$k$,                                  $s$x.id::text$s$),
      ('recurring_occurrences', 'user_id', $k$pg_catalog.jsonb_build_object('rule_id', x.rule_id, 'due_date', x.due_date)$k$, $s$x.rule_id::text || '|' || x.due_date::text$s$),
      ('debts',                 'user_id', $k$pg_catalog.jsonb_build_object('id', x.id)$k$,                                  $s$x.id::text$s$),
      ('debt_payments',         'user_id', $k$pg_catalog.jsonb_build_object('id', x.id)$k$,                                  $s$x.id::text$s$),
      ('assets',                'user_id', $k$pg_catalog.jsonb_build_object('id', x.id)$k$,                                  $s$x.id::text$s$),
      ('asset_valuations',      'user_id', $k$pg_catalog.jsonb_build_object('id', x.id)$k$,                                  $s$x.id::text$s$),
      ('exchange_rates',        'user_id', $k$pg_catalog.jsonb_build_object('id', x.id)$k$,                                  $s$x.id::text$s$),
      ('notification_states',   'user_id', $k$pg_catalog.jsonb_build_object('user_id', x.user_id, 'id', x.id)$k$,           $s$x.id::text$s$)
    ) as l(sql_table, owner_col, key_expr, sort_expr)
  loop
    v_sql := v_sql || case when v_sql = '' then '' else ' union all ' end || pg_catalog.format(
      $f$(select %1$L::text collate "C" as t, x.sync_txid as s, (%2$s) collate "C" as k, %3$s as key, pg_catalog.to_jsonb(x) as r
           from public.%4$I x
          where x.%5$I = $1 and x.sync_txid >= $2 and x.sync_txid < $3
            and ($4 is null or (x.sync_txid, %1$L::text collate "C", (%2$s) collate "C") > ($4, $5 collate "C", $6 collate "C"))
          order by x.sync_txid, 3
          limit $8)$f$,
      t.sql_table, t.sort_expr, t.key_expr, t.sql_table, t.owner_col);
  end loop;

  execute pg_catalog.format($q$
    with o as (
      select u.t, u.s, u.k, u.key, u.r, pg_catalog.row_number() over (order by u.s, u.t, u.k) as n
        from (%s) u
    )
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('table', o.t, 'key', o.key, 'row', o.r) order by o.n) filter (where o.n <= $7), '[]'::jsonb),
           coalesce(pg_catalog.bool_or(o.n > $7), false),
           (select pg_catalog.jsonb_build_object('txid', l.s::text, 'table', l.t, 'key', l.k) from o l where l.n = $7)
      from o
  $q$, v_sql)
  into v_rows, v_more, v_last
  using v_uid, v_cursor, v_bound, a_txid, a_table, a_key, p_limit, p_limit + 1;

  return pg_catalog.jsonb_build_object(
    'bound', v_bound::text,
    'rows', v_rows,
    'next', case when v_more then v_last else null end
  );
end;
$$;

-- Propriétaire : le rôle d'écriture, comme les deux autres fonctions publiques (inventaire
-- homogène ; sans effet sur les droits à l'exécution : SECURITY INVOKER). ALTER OWNER exige le
-- privilège CREATE du nouveau propriétaire sur le schéma : accordé le temps du transfert.
grant create on schema public to nexora_writer;
alter function public.pull_changes(text, text, jsonb, integer) owner to nexora_writer;
revoke create on schema public from nexora_writer;

-- Exécution : authenticated seulement (ni anon, ni service_role, ni PUBLIC).
revoke all on function public.pull_changes(text, text, jsonb, integer) from public, anon, authenticated, service_role;
grant execute on function public.pull_changes(text, text, jsonb, integer) to authenticated;
