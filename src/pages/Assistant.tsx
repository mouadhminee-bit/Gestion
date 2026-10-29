import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Send, ShieldCheck, Sparkles, User } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Card, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { InsightList } from '@/features/insights/InsightList';
import { useMonthData } from '@/features/hooks';
import { generateInsights } from '@/domain/calc/insights';
import type { AssistantAnswer, AssistantFormatters } from '@/domain/assistant';
import { answerIntent, answerQuestion, SUGGESTIONS } from '@/domain/assistant';
import { t } from '@/i18n/core';
import { monthKey } from '@/domain/dates';

interface Msg {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  answer?: AssistantAnswer;
}

let mid = 0;

export default function Assistant() {
  const { ctx, data, today, fmt, settings } = useApp();
  const md = useMonthData(monthKey(today));
  const [messages, setMessages] = useState<Msg[]>([
    { id: ++mid, role: 'assistant', text: t('as.welcome') },
  ]);
  const [q, setQ] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const insights = useMemo(
    () => generateInsights(ctx, data, today, md.forecast, { fmt: (m) => fmt.money(m), locale: settings.locale, monthName: fmt.month, thresholds: settings.budgetAlertThresholds, billReminderDays: settings.billReminderDays, dateFormat: settings.dateFormat }),
    [ctx, data, today, md.forecast, fmt, settings],
  );

  const afmt: AssistantFormatters = { money: (m) => fmt.money(m), percent: fmt.percent, month: fmt.month, date: fmt.date };
  function push(text: string, answer: AssistantAnswer) {
    setMessages((m) => [...m, { id: ++mid, role: 'user', text }, { id: ++mid, role: 'assistant', text: answer.text, answer }]);
  }

  function ask(question: string) {
    const text = question.trim();
    if (!text) return;
    push(text, answerQuestion(text, ctx, data, today, afmt));
    setQ('');
  }

  /** Les suggestions appellent directement l'intention : indépendantes de la langue. */
  function suggest(s: (typeof SUGGESTIONS)[number]) {
    const categoryId = s.categoryKey ? data.categories.find((c) => c.key === s.categoryKey)?.id : undefined;
    push(t(s.key), answerIntent(s.intent, { categoryId, pct: s.pct }, ctx, data, today, afmt));
  }

  return (
    <div>
      <PageHeader eyebrow={t('an.eyebrow')} title={t('as.title')} description={t('as.description')} />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-5">
        <Card className="flex flex-col xl:col-span-3" padded={false}>
          <div className="flex items-center gap-2 border-b border-line/10 px-5 py-3 text-xs text-muted">
            <ShieldCheck className="h-4 w-4 text-positive" /> {t('as.local')}
          </div>
          <div className="max-h-[56vh] min-h-[320px] flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5" aria-live="polite">
            {messages.map((m) => (
              <div key={m.id} className={`flex gap-3 animate-fade-up ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${m.role === 'user' ? 'bg-surface-3' : 'bg-gradient-to-br from-cyan/80 to-violet text-white'}`}>
                  {m.role === 'user' ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                </span>
                <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${m.role === 'user' ? 'bg-primary/15' : 'bg-surface-2/80'}`}>
                  <p className="leading-relaxed">{m.text}</p>
                  {m.answer?.figures && m.answer.figures.length > 0 && (
                    <dl className="mt-3 space-y-1 rounded-xl bg-surface/60 p-3 text-xs">
                      {m.answer.figures.map((f) => (
                        <div key={f.label} className="flex justify-between gap-3"><dt className="text-muted">{f.label}</dt><dd className="num text-end font-medium">{f.value}</dd></div>
                      ))}
                    </dl>
                  )}
                  {m.answer && <p className="mt-2 text-[11px] text-muted"><b>{t('as.source')}</b> {m.answer.source}</p>}
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <div className="border-t border-line/10 p-3 sm:p-4">
            <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
              {SUGGESTIONS.map((s) => (
                <button key={s.key} onClick={() => suggest(s)} className="shrink-0 rounded-full border border-line/15 bg-surface-2/60 px-3 py-1.5 text-xs text-muted transition hover:border-primary/40 hover:text-fg">{t(s.key)}</button>
              ))}
            </div>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('as.placeholder')} aria-label={t('as.question')} />
              <Button type="submit" variant="primary" size="icon" aria-label={t('as.send')} disabled={!q.trim()}><Send className="h-4 w-4" /></Button>
            </form>
          </div>
        </Card>
        <div className="space-y-5 xl:col-span-2">
          <Card title={<span className="flex items-center gap-1.5"><Sparkles className="h-4 w-4 text-cyan" /> {t('as.observations')}</span>}>
            <InsightList insights={insights} />
          </Card>
          <Card title={t('as.about')}>
            <ul className="space-y-2 text-xs text-muted">
              <li>• {t('as.about.1')}</li>
              <li>• {t('as.about.2')}</li>
              <li>• {t('as.about.3')}</li>
              <li>• {t('as.about.4')}</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
