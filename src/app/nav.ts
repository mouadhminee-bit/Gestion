import {
  ArrowLeftRight, Bot, CalendarClock, Gauge, Landmark, LineChart, PieChart, Settings, Target, TrendingUp, Wallet, HandCoins, type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  short?: string;
  icon: LucideIcon;
  group: 'pilotage' | 'gestion' | 'analyse' | 'systeme';
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', short: 'Accueil', icon: Gauge, group: 'pilotage' },
  { to: '/transactions', label: 'Transactions', short: 'Opérations', icon: ArrowLeftRight, group: 'pilotage' },
  { to: '/budgets', label: 'Budgets', icon: PieChart, group: 'pilotage' },
  { to: '/accounts', label: 'Comptes', icon: Wallet, group: 'gestion' },
  { to: '/goals', label: 'Objectifs', icon: Target, group: 'gestion' },
  { to: '/recurring', label: 'Paiements récurrents', short: 'Récurrents', icon: CalendarClock, group: 'gestion' },
  { to: '/debts', label: 'Dettes & créances', short: 'Dettes', icon: HandCoins, group: 'gestion' },
  { to: '/net-worth', label: 'Patrimoine', icon: Landmark, group: 'gestion' },
  { to: '/analytics', label: 'Analyses & rapports', short: 'Analyses', icon: LineChart, group: 'analyse' },
  { to: '/forecast', label: 'Prévisions', icon: TrendingUp, group: 'analyse' },
  { to: '/assistant', label: 'Assistant', icon: Bot, group: 'analyse' },
  { to: '/settings', label: 'Paramètres', icon: Settings, group: 'systeme' },
];

export const NAV_GROUPS: Record<NavItem['group'], string> = {
  pilotage: 'Pilotage',
  gestion: 'Gestion',
  analyse: 'Intelligence',
  systeme: 'Système',
};
