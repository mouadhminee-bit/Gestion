-- =============================================================================
-- 01 — Garde-fous du catalogue (s'appliquent automatiquement à toute table future)
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  t record;
  c record;
  n int;
  priv text;
begin
  select count(*) into n from tests.public_tables;
  perform tests.eq(n, 18, 'le schéma public contient les 18 tables attendues');

  for t in select * from tests.public_tables loop
    perform tests.ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = t.relid),
      format('%s : RLS activée et forcée', t.name));
    foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      perform tests.ok(not has_table_privilege('anon', t.relid, priv), format('%s : anon n''a pas %s', t.name, priv));
    end loop;
    foreach priv in array array['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      perform tests.ok(not has_table_privilege('authenticated', t.relid, priv),
        format('%s : authenticated n''a pas %s (suppression physique impossible)', t.name, priv));
    end loop;
    -- Métadonnées serveur
    for c in select * from (values ('version', 'bigint'), ('sync_txid', 'xid8'),
                                   ('server_updated_at', 'timestamp with time zone'), ('deleted_at', 'timestamp with time zone')) v(col, typ) loop
      perform tests.ok(exists (
        select 1 from pg_attribute a where a.attrelid = t.relid and a.attname = c.col and not a.attisdropped
          and format_type(a.atttypid, a.atttypmod) = c.typ), format('%s : colonne serveur %s (%s)', t.name, c.col, c.typ));
    end loop;
    perform tests.ok(exists (select 1 from pg_trigger g where g.tgrelid = t.relid and not g.tgisinternal
        and g.tgfoid = (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                        where n.nspname = 'private' and p.proname = 'tg_sync_metadata')),
      format('%s : déclencheur de métadonnées serveur', t.name));
    perform tests.ok(exists (
      select 1 from pg_index i where i.indrelid = t.relid
        and (select array_agg(a.attname order by k.ord) from unnest(i.indkey) with ordinality k(attnum, ord)
             join pg_attribute a on a.attrelid = t.relid and a.attnum = k.attnum) in
            (array['user_id', 'sync_txid']::name[], array['id', 'sync_txid']::name[])),
      format('%s : index de récupération des changements', t.name));
  end loop;

  -- Tables portant user_id (toutes sauf profiles)
  select count(*) into n from tests.user_tables;
  perform tests.eq(n, 17, '17 tables portent user_id (profiles exceptée)');
  for t in select * from tests.user_tables loop
    perform tests.ok((select attnotnull from pg_attribute where attrelid = t.relid and attname = 'user_id'),
      format('%s : user_id not null', t.name));
    perform tests.ok(exists (
      select 1 from pg_constraint k where k.conrelid = t.relid and k.contype = 'f'
        and k.confrelid = 'auth.users'::regclass and k.confdeltype = 'c'),
      format('%s : user_id → auth.users on delete cascade', t.name));
    perform tests.ok(exists (select 1 from pg_policy p where p.polrelid = t.relid and p.polcmd = 'r'),
      format('%s : politique de lecture', t.name));
    perform tests.ok(not exists (select 1 from pg_policy p where p.polrelid = t.relid and p.polcmd in ('d', '*')),
      format('%s : aucune politique de suppression ni « for all »', t.name));
  end loop;

  -- Toute politique cible exclusivement authenticated et filtre sur auth.uid()
  for c in select p.polname, p.polrelid::regclass::text as tbl, p.polroles, pg_get_expr(p.polqual, p.polrelid) as q,
                  pg_get_expr(p.polwithcheck, p.polrelid) as w
           from pg_policy p join pg_class r on r.oid = p.polrelid join pg_namespace s on s.oid = r.relnamespace
           where s.nspname = 'public' loop
    perform tests.ok(c.polroles = array['authenticated'::regrole::oid], format('politique %s.%s : rôle authenticated seul', c.tbl, c.polname));
    perform tests.ok(coalesce(c.q, '') || coalesce(c.w, '') like '%auth.uid()%', format('politique %s.%s : filtre auth.uid()', c.tbl, c.polname));
  end loop;
  select count(*) into n from pg_policy p join pg_class r on r.oid = p.polrelid join pg_namespace s on s.oid = r.relnamespace
    where s.nspname = 'public';
  perform tests.eq(n, 17 * 3 + 2, 'nombre de politiques : 3 par table métier + 2 pour profiles');

  -- Clés étrangères : toute référence entre tables publiques est composite (user_id en
  -- tête des deux côtés) et différée.
  select count(*) into n from pg_constraint k join pg_class r on r.oid = k.conrelid join pg_namespace s on s.oid = r.relnamespace
    where s.nspname = 'public' and k.contype = 'f' and k.confrelid <> 'auth.users'::regclass;
  perform tests.eq(n, 25, '25 clés étrangères entre tables NEXORA');
  for c in select k.conname, k.conrelid, k.confrelid, k.conkey, k.confkey, k.condeferrable, k.condeferred
           from pg_constraint k join pg_class r on r.oid = k.conrelid join pg_namespace s on s.oid = r.relnamespace
           where s.nspname = 'public' and k.contype = 'f' and k.confrelid <> 'auth.users'::regclass loop
    perform tests.ok(
      (select attname from pg_attribute where attrelid = c.conrelid and attnum = c.conkey[1]) = 'user_id'
      and (select attname from pg_attribute where attrelid = c.confrelid and attnum = c.confkey[1]) = 'user_id'
      and array_length(c.conkey, 1) = 2,
      format('%s : clé composite (user_id, …)', c.conname));
    perform tests.ok(c.condeferrable and c.condeferred, format('%s : deferrable initially deferred', c.conname));
  end loop;

  -- Aucune autre forme d'accès : pas de vue, pas de fonction exposée dans public.
  select count(*) into n from pg_class r join pg_namespace s on s.oid = r.relnamespace
    where s.nspname = 'public' and r.relkind in ('v', 'm');
  perform tests.eq(n, 0, 'aucune vue dans public (une vue contournerait la RLS)');
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public';
  perform tests.eq(n, 0, 'aucune fonction dans public (aucun appel RPC exposé)');
  perform tests.ok(not has_schema_privilege('authenticated', 'private', 'USAGE'), 'schéma private inaccessible à authenticated');
  perform tests.ok(not has_schema_privilege('anon', 'private', 'USAGE'), 'schéma private inaccessible à anon');
end $$;
