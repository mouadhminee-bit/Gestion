-- =============================================================================
-- NEXORA — Lot 3 / migration 1 : conventions communes
--
-- * Schéma `private` : fonctions internes (déclencheurs), non exposé par l'API.
-- * `private.tg_sync_metadata()` : métadonnées serveur de synchronisation, calculées
--   par le serveur quelle que soit la valeur envoyée par le client :
--     version            1 à l'insertion, +1 à chaque mise à jour ;
--     sync_txid          identifiant de la transaction d'écriture (pg_current_xact_id) ;
--     server_updated_at  now() à chaque écriture ;
--     deleted_at         suppression logique, horodatée par le serveur.
--   Les colonnes passées en argument du déclencheur (TG_ARGV) sont immuables :
--   identifiants, propriétaire, horodatage de création métier.
-- * Les horodatages MÉTIER (created_at / updated_at) restent ceux du client.
-- =============================================================================

create schema if not exists private;
revoke all on schema private from public;

create or replace function private.tg_sync_metadata()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  col text;
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    -- Insertion d'une ligne déjà supprimée (rare) : horodatage serveur.
    if new.deleted_at is not null then
      new.deleted_at := now();
    end if;
  else
    foreach col in array tg_argv loop
      if (to_jsonb(new) -> col) is distinct from (to_jsonb(old) -> col) then
        raise exception 'NEXORA: la colonne % de % est immuable', col, tg_table_name
          using errcode = '42501';
      end if;
    end loop;
    new.version := old.version + 1;
    if new.deleted_at is not null then
      -- Suppression : horodatage serveur ; une ligne déjà supprimée garde sa date.
      new.deleted_at := coalesce(old.deleted_at, now());
    end if;
    -- new.deleted_at null = restauration (réactivation) de la ligne.
  end if;
  new.sync_txid := pg_current_xact_id();
  new.server_updated_at := now();
  return new;
end;
$$;

revoke all on function private.tg_sync_metadata() from public;
