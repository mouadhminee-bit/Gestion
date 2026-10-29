import { afterEach, describe, expect, it } from 'vitest';
import fr from './locales/fr';
import { activateMessages, t, type Messages, type Msg } from './core';
import { LANGUAGES, type Lang } from './languages';
import { generateDemoData } from '@/data/demo';
import { buildContext } from '@/domain/calc/ledger';
import { detectIntent, answerIntent, registerEnglishKeywords, SUGGESTIONS } from '@/domain/assistant';
import { displayCategoryName } from '@/domain/categories.seed';
import { generateInsights } from '@/domain/calc/insights';
import { forecastMonth } from '@/domain/calc/forecast';
import { formatMoney } from '@/domain/money';

const modules = import.meta.glob<{ default: Messages }>('./locales/*.ts', { eager: true });
const locales = new Map<Lang, Messages>(
  Object.entries(modules).map(([path, mod]) => [path.replace('./locales/', '').replace('.ts', '') as Lang, mod.default]),
);
const en = locales.get('en')!;

const placeholders = (m: Msg): Set<string> => {
  const forms = typeof m === 'string' ? [m] : Object.values(m);
  return new Set(forms.flatMap((s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((x) => x[1])));
};

afterEach(() => activateMessages('fr', fr));

describe('Dictionnaires', () => {
  it('chaque langue déclarée possède un dictionnaire, et inversement', () => {
    expect([...locales.keys()].sort()).toEqual(LANGUAGES.map((l) => l.code).sort());
  });

  for (const [lang, messages] of locales) {
    it(`${lang} : mêmes clés que le français, aucun texte vide, variables cohérentes`, () => {
      expect(Object.keys(messages).sort()).toEqual(Object.keys(fr).sort());
      for (const key of Object.keys(fr) as (keyof Messages)[]) {
        const msg = messages[key];
        const ref = placeholders(fr[key]);
        if (typeof msg === 'string') {
          // Seul le fragment de titre placé avant le mot mis en valeur peut être vide (zh).
          if (key !== 'onb.title.before' && key !== 'onb.title.after') expect(msg.trim(), `${lang} ${key}`).not.toBe('');
          expect([...placeholders(msg)].sort(), `${lang} ${key}`).toEqual([...ref].sort());
        } else {
          expect(typeof fr[key], `${lang} ${key} : pluriel attendu`).toBe('object');
          expect(msg.other, `${lang} ${key}`).toBeTruthy();
          // Une forme (ex. « une opération ») peut omettre {count}, mais aucune variable inconnue.
          for (const p of placeholders(msg)) expect(ref.has(p), `${lang} ${key} {${p}}`).toBe(true);
        }
      }
    });
  }
});

describe('Pluriels', () => {
  it('choisit la forme selon Intl.PluralRules de la langue active', () => {
    activateMessages('pl', locales.get('pl')!);
    const pl = [1, 2, 5, 22, 25].map((count) => t('acc.ops', { count }));
    expect(pl[0]).toMatch(/^1 /);
    expect(pl[1]).not.toBe(pl[2]); // few ≠ many
    expect(pl[3].replace('22', '')).toBe(pl[1].replace('2', '')); // 22 → few
    expect(pl[4].replace('25', '')).toBe(pl[2].replace('5', '')); // 25 → many

    activateMessages('ar', locales.get('ar')!);
    expect(t('acc.ops', { count: 2 })).not.toBe(t('acc.ops', { count: 11 }));

    activateMessages('en', en);
    expect(t('acc.ops', { count: 1 })).toBe('1 transaction');
    expect(t('acc.ops', { count: 3 })).toBe('3 transactions');
  });

  it('se replie sur « other » quand la forme demandée est absente', () => {
    activateMessages('ja', locales.get('ja')!);
    expect(t('acc.ops', { count: 1 })).toBe('1 件の取引');
  });
});

describe('Assistant multilingue', () => {
  const today = '2026-10-28';
  const raw = generateDemoData('u', today);
  registerEnglishKeywords(en);

  /** Même transformation que l'interface : noms des catégories initiales traduits. */
  const localized = () => {
    const data = { ...raw, categories: raw.categories.map((c) => ({ ...c, name: displayCategoryName(c) })) };
    return { data, ctx: buildContext(data) };
  };

  for (const [lang, messages] of locales) {
    it(`${lang} : chaque suggestion, tapée librement, retrouve son intention`, () => {
      activateMessages(lang, messages);
      const { data, ctx } = localized();
      for (const s of SUGGESTIONS) {
        const question = t(s.key);
        const { intent, params } = detectIntent(question, ctx);
        expect(intent, `${lang} « ${question} »`).toBe(s.intent);
        if (s.categoryKey) {
          const cat = data.categories.find((c) => c.key === s.categoryKey)!;
          expect(params.categoryId, `${lang} « ${question} » → ${cat.name}`).toBe(cat.id);
        }
        if (s.pct) expect(params.pct).toBe(s.pct);
      }
    });
  }

  it('répond dans la langue active (anglais, arabe)', () => {
    const fmt = { money: (m: number) => formatMoney(m, 'MAD', { locale: 'en-US' }), percent: (r: number | null) => (r == null ? 'n/a' : `${Math.round(r * 100)}%`), month: (m: string) => m, date: (d: string) => d };
    activateMessages('en', en);
    let { data, ctx } = localized();
    const leisure = data.categories.find((c) => c.key === 'leisure')!;
    const a = answerIntent('what_if', { pct: 15, categoryId: leisure.id }, ctx, data, today, fmt);
    expect(a.text).toContain('Leisure');
    expect(a.text).toMatch(/you would save/);

    activateMessages('ar', locales.get('ar')!);
    ({ data, ctx } = localized());
    const b = answerIntent('net_worth', {}, ctx, data, today, fmt);
    expect(b.text).toMatch(/[؀-ۿ]/);
    expect(b.text).not.toMatch(/patrimoine/i);
  });

  it('génère les insights dans la langue active', () => {
    activateMessages('en', en);
    const { data, ctx } = localized();
    const opts = { fmt: (m: number) => formatMoney(m, 'MAD', { locale: 'en-US' }), locale: 'en-US', monthName: (m: string) => m, thresholds: [50, 75, 90, 100], billReminderDays: 7, dateFormat: 'DD/MM/YYYY' as const };
    const ins = generateInsights(ctx, data, today, forecastMonth(ctx, data, today), opts);
    expect(ins.length).toBeGreaterThan(0);
    const all = ins.map((i) => `${i.title} ${i.message} ${i.source}`).join(' ');
    expect(all).not.toMatch(/ dépenses | période /);
  });
});

describe('Noms de catégories', () => {
  it('traduit une catégorie initiale non renommée et conserve un nom saisi', () => {
    activateMessages('es', locales.get('es')!);
    expect(displayCategoryName({ key: 'restaurants', name: 'Restaurants' })).toBe(locales.get('es')!['cat.restaurants']);
    expect(displayCategoryName({ key: 'restaurants', name: 'Sorties resto' })).toBe('Sorties resto');
    expect(displayCategoryName({ name: 'Ma catégorie' })).toBe('Ma catégorie');
  });
});

describe('Calendrier', () => {
  it('affiche toujours les mois grégoriens (fa-IR utiliserait sinon le calendrier persan)', async () => {
    const { formatMonth, formatLongDate } = await import('@/domain/dates');
    expect(formatMonth('2026-10', 'fa-IR')).toMatch(/۲۰۲۶|2026/);
    expect(formatMonth('2026-10', 'fa-IR')).not.toMatch(/مهر|۱۴۰۵/);
    expect(formatLongDate('2026-10-29', 'fa-IR')).toMatch(/۲۹|29/);
    expect(formatMonth('2026-10', 'en-US')).toBe('October 2026');
  });
});
