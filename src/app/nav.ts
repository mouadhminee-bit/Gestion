import {
  ArrowLeftRight, Bot, CalendarClock, Gauge, Landmark, LineChart, PieChart, Settings, Target, TrendingUp, Wallet, HandCoins, type LucideIcon,
} from 'lucide-react';
import { td } from '@/i18n/core';
import { lazyLabels } from '@/i18n/labels';

export interface NavItem {
  to: string;
  key: string;
  icon: LucideIcon;
  group: 'pilotage' | 'gestion' | 'analyse' | 'systeme';
  /** Libellé court pour la barre mobile. */
  hasShort?: boolean;
}

export const NAV: NavItem[] = [
  { to: '/', key: 'dashboard', icon: Gauge, group: 'pilotage', hasShort: true },
  { to: '/transactions', key: 'transactions', icon: ArrowLeftRight, group: 'pilotage', hasShort: true },
  { to: '/budgets', key: 'budgets', icon: PieChart, group: 'pilotage' },
  { to: '/accounts', key: 'accounts', icon: Wallet, group: 'gestion' },
  { to: '/goals', key: 'goals', icon: Target, group: 'gestion' },
  { to: '/recurring', key: 'recurring', icon: CalendarClock, group: 'gestion', hasShort: true },
  { to: '/debts', key: 'debts', icon: HandCoins, group: 'gestion', hasShort: true },
  { to: '/net-worth', key: 'netWorth', icon: Landmark, group: 'gestion' },
  { to: '/analytics', key: 'analytics', icon: LineChart, group: 'analyse', hasShort: true },
  { to: '/forecast', key: 'forecast', icon: TrendingUp, group: 'analyse' },
  { to: '/assistant', key: 'assistant', icon: Bot, group: 'analyse' },
  { to: '/settings', key: 'settings', icon: Settings, group: 'systeme' },
];

export const navLabel = (n: NavItem) => td(`nav.${n.key}`);
export const navShort = (n: NavItem) => (n.hasShort ? td(`nav.short.${n.key}`) : navLabel(n));

export const NAV_GROUPS: Record<NavItem['group'], string> = lazyLabels('navGroup', ['pilotage', 'gestion', 'analyse', 'systeme']);
