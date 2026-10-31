/** Erreur de validation métier (déplacée depuis `data/repository.ts`, qui la ré-exporte). */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly fields: Record<string, string | undefined> = {},
  ) {
    // Le message expose la première erreur de champ, plus utile qu'un libellé générique.
    super(Object.values(fields).find(Boolean) ?? message);
    this.name = 'ValidationError';
  }
}
