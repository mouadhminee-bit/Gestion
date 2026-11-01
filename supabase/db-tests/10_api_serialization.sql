-- =============================================================================
-- 10 — Sérialisation des double precision par l'API (émulation fidèle de PostgREST)
--
-- PostgREST (src/library/PostgREST/Config/Database.hs, Query/PreQuery.hs) :
--  1. lit au démarrage / rechargement les réglages des rôles dont `authenticator` est membre
--     (pg_roles.rolconfig) ;
--  2. pour chaque requête : set_config('role', <rôle endossé>, true), puis
--     set_config(<réglage>, <valeur>, true) pour chaque réglage de ce rôle ;
--  3. construit la réponse avec json_agg(...) : chaque float8 y est converti en texte selon
--     extra_float_digits de la session.
-- Ce fichier rejoue cette séquence et vérifie, sur les BITS, que la réponse JSON se relit
-- à l'identique. Contrôle : la même requête SANS les réglages de rôle, qui reproduit la
-- perte quand la session hérite de extra_float_digits = 0 (image Supabase).
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u uuid := tests.new_user('api-float');
  ids jsonb := tests.seed(u);
  c record;
  s record;
  role_settings jsonb;
  session_efd text := current_setting('extra_float_digits');
  session_src text := (select format('%s, fichier : %s', source, coalesce(sourcefile, '—')) from pg_settings where name = 'extra_float_digits');
  json_without text;
  json_with text;
  bits_without text;
  bits_with text;
  r text;
begin
  -- Réglages de rôle posés par la migration 7 (strict)
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    perform tests.ok(exists (select 1 from pg_roles where rolname = r and 'extra_float_digits=1' = any (rolconfig)),
      format('%s : extra_float_digits = 1 (réglage de rôle appliqué par PostgREST)', r));
  end loop;

  -- Requête de PostgREST (queryRoleSettings), telle qu'exécutée par authenticator
  select coalesce(jsonb_object_agg(rolname || '.' || key, value), '{}') into role_settings from (
      select r.rolname, substr(setting, 1, strpos(setting, '=') - 1) as key, substr(setting, strpos(setting, '=') + 1) as value
      from pg_auth_members m join pg_roles r on r.oid = m.roleid, unnest(r.rolconfig) as setting
      where m.member = 'authenticator'::regrole::oid) kv;
    perform tests.ok(role_settings ->> 'authenticated.extra_float_digits' = '1' and role_settings ->> 'anon.extra_float_digits' = '1',
      'requête de réglages de PostgREST (authenticator) : extra_float_digits = 1 pour anon et authenticated', role_settings::text);

  for c in select * from (values
      ('taux 0.1 + 0.2', 0.30000000000000004::float8, '3fd3333333333334', '0.30000000000000004'),
      ('taux 1/3', (1::float8 / 3), '3fd5555555555555', '0.3333333333333333'),
      ('taux 10.86', 10.86::float8, '4025b851eb851eb8', '10.86'),
      ('taux d''intérêt 4.123456789012345', 4.123456789012345::float8, '40107e6b74dd1bd9', '4.123456789012345')
    ) v(label, val, bits, js_json) loop
    -- Écriture par l'API : PostgREST transmet le corps JSON et le convertit par
    -- json_to_recordset (Query/SqlFragment.hs) — la lecture du nombre ne dépend pas de
    -- extra_float_digits. Vérifié sous le réglage hérité de la session, avec le texte JSON
    -- exact produit par JavaScript (JSON.stringify : forme la plus courte).
    perform tests.eq((select encode(float8send(x.rate), 'hex')
                        from json_to_recordset(format('[{"rate": %s}]', c.js_json)::json) as x(rate double precision)),
      c.bits, format('%s : corps JSON lu par json_to_recordset (chemin d''écriture de PostgREST) = bits exacts', c.label));
    update public.exchange_rates set rate = c.val where id = (ids ->> 'exchange_rates')::uuid;

    -- Requête PostgREST SANS les réglages de rôle (contrôle)
    perform tests.as_user(u);
    select coalesce(json_agg(t), '[]')::text into json_without
      from (select rate from public.exchange_rates where id = (ids ->> 'exchange_rates')::uuid) t;
    -- Même requête AVEC les réglages du rôle endossé, appliqués comme PreQuery
    for s in select substr(setting, 1, strpos(setting, '=') - 1) as k, substr(setting, strpos(setting, '=') + 1) as v
             from pg_roles, unnest(rolconfig) as setting where rolname = 'authenticated' loop
      perform set_config(s.k, s.v, true);
    end loop;
    select coalesce(json_agg(t), '[]')::text into json_with
      from (select rate from public.exchange_rates where id = (ids ->> 'exchange_rates')::uuid) t;
    perform set_config('extra_float_digits', session_efd, true);
    perform tests.as_admin();

    bits_without := encode(float8send(((json_without::jsonb) -> 0 ->> 'rate')::float8), 'hex');
    bits_with := encode(float8send(((json_with::jsonb) -> 0 ->> 'rate')::float8), 'hex');
    perform tests.eq(bits_with, c.bits, format('%s : réponse JSON de l''API (réglages de rôle appliqués) relue à l''identique', c.label));
    if session_efd = '0' then
      perform tests.ok(true, format('CONSTAT %s sans réglage de rôle (session à 0)', c.label),
        format('JSON %s → bits %s (%s)', json_without, bits_without, case when bits_without = c.bits then 'exact' else 'ARRONDI' end));
    end if;
  end loop;
  perform tests.ok(true, 'CONSTAT extra_float_digits hérité par les sessions', format('%s (source : %s)', session_efd, session_src));
end $$;
