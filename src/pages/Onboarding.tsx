import { useState } from 'react';
import { ArrowRight, FlaskConical, ShieldCheck, Sparkles, Wallet } from 'lucide-react';
import { Logo } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { Field, Input, MoneyInput, Select } from '@/components/ui/Field';
import { errorMessage, useToast } from '@/components/ui/Toast';
import type { LocalRepository } from '@/data/repository';
import { generateDemoData } from '@/data/demo';
import { CURRENCIES } from '@/domain/money';
import { todayISO } from '@/domain/dates';
import type { UserSettings } from '@/domain/types';
import { localeOptions } from '@/domain/settings';
import { getLang, t } from '@/i18n/core';
import { languageInfo } from '@/i18n/languages';
import { LanguageSelect } from '@/components/ui/LanguageSelect';
import { currencyName } from '@/i18n/labels';

export function Onboarding({ repo, existing }: { repo: LocalRepository; existing?: UserSettings }) {
  const toast = useToast();
  const [step, setStep] = useState<'welcome' | 'setup'>('welcome');
  const [name, setName] = useState(existing?.displayName ?? '');
  const [currency, setCurrency] = useState(existing?.baseCurrency ?? 'MAD');
  const [locale, setLocale] = useState(existing?.locale ?? (getLang() === 'fr' ? 'fr-MA' : languageInfo(getLang()).locale));
  const [accountName, setAccountName] = useState(t('demo.acc.checking'));
  const [balance, setBalance] = useState<number | null>(0);
  const [busy, setBusy] = useState(false);

  async function startDemo() {
    setBusy(true);
    try {
      const today = todayISO('Africa/Casablanca');
      await repo.replaceWithSnapshot(generateDemoData(repo.userId, today));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function startFresh() {
    setBusy(true);
    try {
      await repo.ensureUser(name.trim());
      const today = todayISO('Africa/Casablanca');
      await repo.updateSettings({ displayName: name.trim(), baseCurrency: currency, locale, language: getLang() });
      if (accountName.trim()) {
        await repo.createAccount({ name: accountName.trim(), type: 'bank', currency, initialBalance: balance ?? 0, initialBalanceDate: today, archived: false, includeInTotal: true, color: '#5271FF', order: 0 });
      }
      await repo.updateSettings({ onboarded: true, demoMode: false });
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-4xl">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-3 animate-fade-in">
          <Logo />
          <LanguageSelect className="w-[220px]" />
        </div>
        {step === 'welcome' ? (
          <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr] lg:items-center">
            <div className="animate-fade-up">
              <div className="label mb-3">{t('shell.tagline')}</div>
              <h1 className="display text-4xl font-semibold leading-tight sm:text-5xl">
                {t('onb.title.before')} <span className="gradient-text">{t('onb.title.highlight')}</span>{t('onb.title.after')}
              </h1>
              <p className="mt-4 max-w-lg text-muted">
                {t('onb.subtitle')}
              </p>
              <ul className="mt-6 space-y-2.5 text-sm">
                <li className="flex items-center gap-2.5"><Sparkles className="h-4 w-4 shrink-0 text-cyan" /> {t('onb.point1')}</li>
                <li className="flex items-center gap-2.5"><Wallet className="h-4 w-4 shrink-0 text-cyan" /> {t('onb.point2')}</li>
                <li className="flex items-center gap-2.5"><ShieldCheck className="h-4 w-4 shrink-0 text-cyan" /> {t('onb.point3')}</li>
              </ul>
            </div>
            <div className="card space-y-3 p-5 animate-fade-up" style={{ animationDelay: '120ms' }}>
              <button onClick={startDemo} disabled={busy} className="group w-full rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/15 to-violet/10 p-4 text-left transition hover:border-primary/60">
                <div className="flex items-center gap-2 font-semibold">
                  <FlaskConical className="h-4 w-4 text-cyan" /> {t('onb.demo')}
                </div>
                <p className="mt-1 text-xs text-muted">{t('onb.demoHint')}</p>
              </button>
              <button onClick={() => setStep('setup')} disabled={busy} className="w-full rounded-2xl border border-line/15 bg-surface-2/60 p-4 text-left transition hover:border-line/40">
                <div className="flex items-center gap-2 font-semibold">
                  <ArrowRight className="h-4 w-4 text-primary rtl:-scale-x-100" /> {t('onb.fresh')}
                </div>
                <p className="mt-1 text-xs text-muted">{t('onb.freshHint')}</p>
              </button>
            </div>
          </div>
        ) : (
          <div className="card mx-auto max-w-lg p-6 animate-fade-up">
            <h2 className="display text-xl font-semibold">{t('onb.setup')}</h2>
            <p className="mt-1 text-sm text-muted">{t('onb.setupHint')}</p>
            <div className="mt-5 grid gap-4">
              <Field label={t('onb.name')}>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('onb.namePlaceholder')} autoFocus />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('settings.baseCurrency')}>
                  <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                    {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} — {currencyName(c.code, getLang())}</option>)}
                  </Select>
                </Field>
                <Field label={t('settings.numberFormats')}>
                  <Select value={locale} onChange={(e) => setLocale(e.target.value)}>
                    {localeOptions(getLang()).map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                  </Select>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('onb.firstAccount')}>
                  <Input value={accountName} onChange={(e) => setAccountName(e.target.value)} />
                </Field>
                <Field label={t('onb.balance')} hint={t('onb.balanceHint')}>
                  <MoneyInput value={balance} onChange={setBalance} currency={currency} allowNegative />
                </Field>
              </div>
            </div>
            <div className="mt-6 flex justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep('welcome')}>{t('common.back')}</Button>
              <Button variant="primary" loading={busy} onClick={startFresh}>{t('onb.start')}</Button>
            </div>
          </div>
        )}
        <p className="mt-8 text-center text-[11px] text-muted">
          {t('onb.footer')}
        </p>
      </div>
    </div>
  );
}
