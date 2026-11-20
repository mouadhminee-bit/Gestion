/**
 * V3.5 (M9) — erreurs d'écriture Cloud : message traduit, sans détail technique (ni nom de
 * table, ni code serveur, ni texte d'erreur réseau brut). Autres erreurs : comportement inchangé.
 */
import { describe, expect, it } from 'vitest';
import { errorMessage } from './Toast';
import { CloudFeatureUnavailableError } from '@/data/cloud/cloudWorkspace';
import { CloudCacheWriteError, CloudConflictError, CloudProtocolError, CloudTransientRejectionError, CloudTransportError, CloudWriteDisabledError } from '@/data/cloud/transport';
import { ValidationError } from '@/domain/errors';
import fr from '@/i18n/locales/fr';

const conflict = new CloudConflictError([{ table: 'accounts', key: 'k', expectedVersion: 1, actualVersion: 2, actualDeleted: false }]);

describe('V3.5 — messages des erreurs d’écriture Cloud', () => {
  const cases: [string, unknown, string][] = [
    ['conflit de version', conflict, fr['cloud.write.conflict']],
    ['issue inconnue (réseau)', new CloudTransportError(new TypeError('Failed to fetch')), fr['cloud.write.unconfirmed']],
    ['refus temporaire transmis par le transport', new CloudTransportError(new CloudTransientRejectionError('invalid_row', '40001', 'serialization_failure on user_settings')), fr['cloud.write.unavailable']],
    ['refus temporaire direct', new CloudTransientRejectionError('429', null, 'rate limit'), fr['cloud.write.unavailable']],
    ['refus définitif transmis par le transport', new CloudTransportError(new CloudProtocolError('invalid_row', 'transactions.amount')), fr['cloud.write.rejected']],
    ['refus définitif direct', new CloudProtocolError('duplicate_key', 'accounts'), fr['cloud.write.rejected']],
    ['session refusée', new CloudProtocolError('unauthorized', 'lot attribué à un autre utilisateur'), fr['cloud.write.denied']],
    ['session refusée transmise', new CloudTransportError(new CloudProtocolError('unauthorized', 'jwt')), fr['cloud.write.denied']],
    ['cache non mis à jour', new CloudCacheWriteError(new Error('QuotaExceededError')), fr['cloud.write.cacheStale']],
    ['écriture désactivée', new CloudWriteDisabledError(), fr['cloud.write.rejected']],
    ['fonction indisponible', new CloudFeatureUnavailableError('attachments'), fr['cloud.feature.unavailable']],
  ];
  for (const [label, error, expected] of cases) {
    it(`${label} → message traduit sans détail technique`, () => {
      const m = errorMessage(error);
      expect(m).toBe(expected);
      for (const leak of ['accounts', 'user_settings', 'transactions', 'invalid_row', 'duplicate_key', '40001', 'Failed to fetch', 'Quota', 'jwt']) expect(m).not.toContain(leak);
    });
  }

  it('autres erreurs : comportement inchangé', () => {
    expect(errorMessage(new ValidationError('Montant invalide'))).toBe('Montant invalide');
    expect(errorMessage(new Error('court'))).toBe('court');
    expect(errorMessage(new Error('x'.repeat(200)))).toBe(fr['common.unexpectedError']);
    expect(errorMessage('texte')).toBe(fr['common.unexpectedError']);
  });

  it('les 8 nouvelles clés existent dans les 24 langues, non vides, sans « cloud.pending »', async () => {
    const { LANGUAGES } = await import('@/i18n/languages');
    const keys = ['cloud.write.conflict', 'cloud.write.unconfirmed', 'cloud.write.unavailable', 'cloud.write.denied', 'cloud.write.rejected', 'cloud.write.cacheStale', 'cloud.feature.unavailable', 'cloud.limited'];
    expect(LANGUAGES).toHaveLength(24);
    for (const l of LANGUAGES) {
      const dict = ((await import(`../../i18n/locales/${l.code}.ts`)) as { default: Record<string, string> }).default;
      for (const k of keys) expect(dict[k], `${l.code} ${k}`).toMatch(/\S/);
      expect(dict['cloud.pending']).toBeUndefined();
    }
  });
});
