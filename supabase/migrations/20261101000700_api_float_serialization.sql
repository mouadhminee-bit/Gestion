-- =============================================================================
-- NEXORA — Lot 3b / migration 7 : sérialisation exacte des double precision par l'API
--
-- Constat (qualification 3b, pile Supabase locale) : l'image PostgreSQL de Supabase fixe
-- `extra_float_digits = 0` dans postgresql.conf. Toutes les sessions en héritent, y compris
-- celles de PostgREST : les réponses JSON (json_agg → texte du float8) n'ont alors que
-- 15 chiffres significatifs (0.30000000000000004 → 0.3, 4.123456789012345 → 4.12345678901235),
-- valeurs que le client relit DIFFÉREMMENT de ce qui est stocké. Stockage et écriture sont
-- exacts ; la perte a lieu à la sérialisation de la réponse.
--
-- Correction : PostgREST applique à chaque requête, en paramètres locaux à la transaction,
-- les réglages du rôle endossé (anon / authenticated / service_role) — mécanisme que
-- Supabase utilise lui-même pour statement_timeout. `extra_float_digits = 1` (défaut de
-- PostgreSQL ≥ 12) donne la représentation la plus courte qui se relit à l'identique.
--
-- * N'affecte que la REPRÉSENTATION texte / JSON des flottants (aucun calcul, aucun stockage).
-- * Sans effet hors Supabase (1 est déjà la valeur par défaut de PostgreSQL).
-- * `postgres` détient l'option ADMIN sur ces rôles (Supabase, PostgreSQL ≥ 16).
-- * Les réglages de rôle sont globaux à l'instance : PostgREST ne lit que ceux-là
--   (pg_roles.rolconfig), pas les réglages « in database ».
-- =============================================================================

alter role anon set extra_float_digits = 1;
alter role authenticated set extra_float_digits = 1;
alter role service_role set extra_float_digits = 1;

-- PostgREST relit les réglages de rôle lors d'un rechargement de configuration.
notify pgrst, 'reload config';
