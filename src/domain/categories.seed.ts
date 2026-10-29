import type { Category, CategoryKind, ExpenseNature } from './types';
import { newId, nowISO } from '@/lib/id';
import { td } from '@/i18n/core';

interface SeedCategory {
  key: string;
  name: string;
  kind: CategoryKind;
  nature?: ExpenseNature;
  icon: string;
  color: string;
  children?: { key: string; name: string; icon: string }[];
}

/** Structure initiale des catégories (modifiable par l'utilisateur). */
export const SEED_CATEGORIES: SeedCategory[] = [
  // Revenus
  { key: 'salary', name: 'Salaire', kind: 'income', icon: 'Briefcase', color: '#25D9A0' },
  { key: 'bonus', name: 'Primes', kind: 'income', icon: 'Award', color: '#41E7F5' },
  { key: 'freelance', name: 'Revenus indépendants', kind: 'income', icon: 'Laptop', color: '#5271FF' },
  { key: 'rental', name: 'Revenus locatifs', kind: 'income', icon: 'Building2', color: '#9B7BFF' },
  { key: 'dividends', name: 'Dividendes et intérêts', kind: 'income', icon: 'TrendingUp', color: '#7DD3FC' },
  { key: 'refunds_in', name: 'Remboursements reçus', kind: 'income', icon: 'Undo2', color: '#A3E635' },
  { key: 'other_income', name: 'Autres revenus', kind: 'income', icon: 'PlusCircle', color: '#94A3B8' },
  // Dépenses fixes
  { key: 'rent', name: 'Loyer', kind: 'expense', nature: 'fixed', icon: 'Home', color: '#5271FF' },
  { key: 'utilities', name: 'Eau et électricité', kind: 'expense', nature: 'fixed', icon: 'Zap', color: '#FFBF69' },
  { key: 'telecom', name: 'Internet et téléphone', kind: 'expense', nature: 'fixed', icon: 'Wifi', color: '#41E7F5' },
  {
    key: 'subscriptions', name: 'Abonnements', kind: 'expense', nature: 'fixed', icon: 'Repeat', color: '#9B7BFF',
    children: [
      { key: 'streaming', name: 'Streaming', icon: 'Tv' },
      { key: 'software', name: 'Logiciels et cloud', icon: 'Cloud' },
    ],
  },
  { key: 'insurance', name: 'Assurances', kind: 'expense', nature: 'fixed', icon: 'ShieldCheck', color: '#60A5FA' },
  { key: 'loan_payments', name: 'Échéances de crédit', kind: 'expense', nature: 'fixed', icon: 'Landmark', color: '#F472B6' },
  { key: 'other_fixed', name: 'Autres charges fixes', kind: 'expense', nature: 'fixed', icon: 'Receipt', color: '#94A3B8' },
  // Dépenses variables
  {
    key: 'food', name: 'Alimentation', kind: 'expense', nature: 'variable', icon: 'ShoppingBasket', color: '#25D9A0',
    children: [
      { key: 'groceries', name: 'Courses', icon: 'ShoppingCart' },
      { key: 'market', name: 'Marché et souk', icon: 'Apple' },
    ],
  },
  { key: 'restaurants', name: 'Restaurants', kind: 'expense', nature: 'variable', icon: 'UtensilsCrossed', color: '#FF8A65' },
  {
    key: 'transport', name: 'Transport', kind: 'expense', nature: 'variable', icon: 'Car', color: '#41E7F5',
    children: [
      { key: 'fuel', name: 'Carburant', icon: 'Fuel' },
      { key: 'public_transport', name: 'Taxi, tram et train', icon: 'TramFront' },
      { key: 'parking', name: 'Parking et péage', icon: 'ParkingCircle' },
    ],
  },
  { key: 'health', name: 'Santé', kind: 'expense', nature: 'variable', icon: 'HeartPulse', color: '#FF6178' },
  { key: 'clothing', name: 'Habillement', kind: 'expense', nature: 'variable', icon: 'Shirt', color: '#C084FC' },
  {
    key: 'leisure', name: 'Loisirs', kind: 'expense', nature: 'variable', icon: 'Gamepad2', color: '#9B7BFF',
    children: [
      { key: 'outings', name: 'Sorties', icon: 'Ticket' },
      { key: 'sport', name: 'Sport', icon: 'Dumbbell' },
    ],
  },
  { key: 'shopping', name: 'Shopping', kind: 'expense', nature: 'variable', icon: 'ShoppingBag', color: '#F59E0B' },
  { key: 'travel', name: 'Voyages', kind: 'expense', nature: 'variable', icon: 'Plane', color: '#38BDF8' },
  { key: 'gifts', name: 'Cadeaux', kind: 'expense', nature: 'variable', icon: 'Gift', color: '#F472B6' },
  { key: 'personal', name: 'Dépenses personnelles', kind: 'expense', nature: 'variable', icon: 'User', color: '#A78BFA' },
  { key: 'other_expense', name: 'Autres dépenses', kind: 'expense', nature: 'variable', icon: 'CircleDot', color: '#94A3B8' },
  // Épargne et patrimoine (affectations de transferts — jamais des dépenses)
  { key: 'emergency_fund', name: 'Épargne de précaution', kind: 'savings', icon: 'LifeBuoy', color: '#25D9A0' },
  { key: 'project_savings', name: 'Épargne projet', kind: 'savings', icon: 'Target', color: '#41E7F5' },
  { key: 'investments', name: 'Investissements', kind: 'savings', icon: 'LineChart', color: '#5271FF' },
  { key: 'other_savings', name: "Autres affectations d'épargne", kind: 'savings', icon: 'PiggyBank', color: '#9B7BFF' },
];

const SEED_NAMES = new Map<string, string>();
for (const c of SEED_CATEGORIES) {
  SEED_NAMES.set(c.key, c.name);
  c.children?.forEach((ch) => SEED_NAMES.set(ch.key, ch.name));
}

/**
 * Nom affiché d'une catégorie : traduction de la catégorie initiale tant que
 * l'utilisateur ne l'a pas renommée ; sinon le nom saisi par l'utilisateur.
 */
export function displayCategoryName(c: Pick<Category, 'key' | 'name'>): string {
  if (c.key && SEED_NAMES.get(c.key) === c.name) return td(`cat.${c.key}`);
  return c.name;
}

export function buildSeedCategories(userId: string): Category[] {
  const now = nowISO();
  const out: Category[] = [];
  SEED_CATEGORIES.forEach((c, index) => {
    const id = newId();
    out.push({
      id,
      userId,
      key: c.key,
      name: c.name,
      kind: c.kind,
      nature: c.nature,
      parentId: null,
      icon: c.icon,
      color: c.color,
      archived: false,
      order: index * 10,
      createdAt: now,
      updatedAt: now,
    });
    c.children?.forEach((child, j) => {
      out.push({
        id: newId(),
        userId,
        key: child.key,
        name: child.name,
        kind: c.kind,
        nature: c.nature,
        parentId: id,
        icon: child.icon,
        color: c.color,
        archived: false,
        order: j * 10,
        createdAt: now,
        updatedAt: now,
      });
    });
  });
  return out;
}
