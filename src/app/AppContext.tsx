/**
 * État applicatif partagé.
 *
 * La source de vérité est IndexedDB : `useLiveQuery` fournit un instantané en
 * lecture seule, recalculé automatiquement après chaque écriture du repository.
 * Les composants ne modifient jamais cet instantané directement.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getDB } from '@/data/db';
import { LocalRepository } from '@/data/repository';
import { LOCAL_USER_ID } from '@/domain/settings';
import type { DataSnapshot, UserSettings } from '@/domain/types';
import type { LedgerContext } from '@/domain/calc/ledger';
import { buildContext } from '@/domain/calc/ledger';
import type { ISODate, MonthKey } from '@/domain/dates';
import { formatDate, formatMonth, monthKey, todayISO } from '@/domain/dates';
import type { CurrencyCode } from '@/domain/money';
import { formatMoney, formatPercent } from '@/domain/money';
import { displayCategoryName } from '@/domain/categories.seed';
import { getLang } from '@/i18n/core';

export interface Formatters {
  money: (minor: number, currency?: CurrencyCode, opts?: { sign?: boolean; compact?: boolean; force?: boolean }) => string;
  percent: (ratio: number | null, digits?: number) => string;
  date: (d: ISODate | undefined | null) => string;
  month: (m: MonthKey) => string;
  /** Masque un montant quand le mode confidentialité est actif. */
  hidden: boolean;
}

interface AppState {
  repo: LocalRepository;
  data: DataSnapshot;
  settings: UserSettings;
  ctx: LedgerContext;
  today: ISODate;
  month: MonthKey;
  setMonth: (m: MonthKey) => void;
  fmt: Formatters;
  /** Locale de l'interface (noms des mois et des jours), distincte des formats numériques. */
  uiLocale: string;
}

const AppCtx = createContext<AppState | null>(null);

export const MASK = '••••••';

export function uiLocaleFor(settings: Pick<UserSettings, 'locale'>): string {
  const region = settings.locale.split('-')[1];
  const lang = getLang();
  return region ? `${lang}-${region}` : lang;
}

export function makeFormatters(settings: UserSettings): Formatters {
  const hidden = settings.privacyMode;
  return {
    hidden,
    money: (minor, currency = settings.baseCurrency, opts = {}) => {
      if (hidden && !opts.force) return `${MASK} ${currency === 'MAD' && settings.currencyDisplay === 'symbol' ? 'DH' : currency}`;
      return formatMoney(minor, currency, {
        locale: settings.locale,
        display: settings.currencyDisplay,
        signDisplay: opts.sign ? 'exceptZero' : 'auto',
        compact: opts.compact,
      });
    },
    percent: (ratio, digits = 1) => formatPercent(ratio, settings.locale, digits),
    date: (d) => formatDate(d, settings.dateFormat),
    month: (m) => formatMonth(m, uiLocaleFor(settings)),
  };
}

export function useRepository(): LocalRepository {
  return useMemo(() => new LocalRepository(getDB(), LOCAL_USER_ID), []);
}

/** Recalcule « aujourd'hui » chaque minute (changement de jour à minuit). */
function useToday(timeZone: string): ISODate {
  const [today, setToday] = useState(() => todayISO(timeZone));
  useEffect(() => {
    setToday(todayISO(timeZone));
    const id = window.setInterval(() => setToday(todayISO(timeZone)), 60_000);
    return () => window.clearInterval(id);
  }, [timeZone]);
  return today;
}

export function AppProvider({ repo, data: rawData, children }: { repo: LocalRepository; data: DataSnapshot; children: ReactNode }) {
  // Catégories initiales affichées dans la langue active (sauf si renommées).
  const data = useMemo(() => ({ ...rawData, categories: rawData.categories.map((c) => ({ ...c, name: displayCategoryName(c) })) }), [rawData]);
  const settings = data.settings;
  const today = useToday(settings.timeZone);
  const [month, setMonthState] = useState<MonthKey>(() => {
    try {
      return sessionStorage.getItem('nexora.month') || monthKey(today);
    } catch {
      return monthKey(today);
    }
  });
  const setMonth = useCallback((m: MonthKey) => {
    setMonthState(m);
    try {
      sessionStorage.setItem('nexora.month', m);
    } catch {
      /* stockage indisponible : préférence non mémorisée */
    }
  }, []);
  const ctx = useMemo(() => buildContext(data), [data]);
  const fmt = useMemo(() => makeFormatters(settings), [settings]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', settings.theme === 'dark');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', settings.theme === 'dark' ? '#080D1A' : '#F3F6FC');
    try {
      localStorage.setItem('nexora.theme', settings.theme);
    } catch {
      /* ignore */
    }
  }, [settings.theme]);

  const uiLocale = uiLocaleFor(settings);
  const value = useMemo<AppState>(() => ({ repo, data, settings, ctx, today, month, setMonth, fmt, uiLocale }), [repo, data, settings, ctx, today, month, setMonth, fmt, uiLocale]);
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(AppCtx);
  if (!v) throw new Error('useApp hors AppProvider');
  return v;
}

/** Charge l'instantané en direct ; `null` = aucun profil (onboarding), `undefined` = chargement. */
export function useSnapshot(repo: LocalRepository) {
  return useLiveQuery(() => repo.snapshot(), [repo]);
}
