/**
 * Registre des icônes utilisables pour les catégories, comptes et objectifs.
 * Import explicite (et non dynamique) pour garder un bundle léger.
 */
import {
  Apple, Award, Banknote, Briefcase, Building2, Car, CircleDot, Cloud, CreditCard, Dumbbell, Fuel, Gamepad2, Gift,
  GraduationCap, HeartPulse, Home, Landmark, Laptop, LifeBuoy, LineChart, ParkingCircle, PiggyBank, Plane, PlusCircle,
  Receipt, Repeat, Shirt, ShieldCheck, ShoppingBag, ShoppingBasket, ShoppingCart, Smartphone, Target, Ticket, TramFront,
  TrendingUp, Tv, Undo2, User, UtensilsCrossed, Wallet, Wifi, Zap, Baby, Book, Coffee, Dog, Music, Palette, Wrench,
  Bike, Bus, Gem, Hammer, Pill, Sparkles, Stethoscope, Sun, Umbrella, Vault, Coins, type LucideIcon,
} from 'lucide-react';

export const ICONS: Record<string, LucideIcon> = {
  Apple, Award, Banknote, Briefcase, Building2, Car, CircleDot, Cloud, CreditCard, Dumbbell, Fuel, Gamepad2, Gift,
  GraduationCap, HeartPulse, Home, Landmark, Laptop, LifeBuoy, LineChart, ParkingCircle, PiggyBank, Plane, PlusCircle,
  Receipt, Repeat, Shirt, ShieldCheck, ShoppingBag, ShoppingBasket, ShoppingCart, Smartphone, Target, Ticket, TramFront,
  TrendingUp, Tv, Undo2, User, UtensilsCrossed, Wallet, Wifi, Zap, Baby, Book, Coffee, Dog, Music, Palette, Wrench,
  Bike, Bus, Gem, Hammer, Pill, Sparkles, Stethoscope, Sun, Umbrella, Vault, Coins,
};

export const ICON_NAMES = Object.keys(ICONS);

export function iconFor(name: string | undefined): LucideIcon {
  return (name && ICONS[name]) || CircleDot;
}

export const COLOR_SWATCHES = [
  '#5271FF', '#41E7F5', '#9B7BFF', '#25D9A0', '#FFBF69', '#FF6178', '#F472B6', '#38BDF8',
  '#A3E635', '#FF8A65', '#C084FC', '#60A5FA', '#F59E0B', '#94A3B8',
];
