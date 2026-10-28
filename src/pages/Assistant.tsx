import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Send, ShieldCheck, Sparkles, User } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { Card, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { InsightList } from '@/features/insights/InsightList';
import { useMonthData } from '@/features/hooks';
import { generateInsights } from '@/domain/calc/insights';
import type { AssistantAnswer } from '@/domain/assistant';
import { answerQuestion, SUGGESTED_QUESTIONS } from '@/domain/assistant';
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
    { id: ++mid, role: 'assistant', text: 'Bonjour ! Posez-moi une question sur vos finances. Je calcule chaque réponse à partir de vos données, et j’indique toujours d’où viennent les chiffres.' },
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

  function ask(question: string) {
    const text = question.trim();
    if (!text) return;
    const answer = answerQuestion(text, ctx, data, today, { money: (m) => fmt.money(m), percent: fmt.percent, month: fmt.month, date: fmt.date });
    setMessages((m) => [...m, { id: ++mid, role: 'user', text }, { id: ++mid, role: 'assistant', text: answer.text, answer }]);
    setQ('');
  }

  return (
    <div>
      <PageHeader eyebrow="Intelligence" title="Assistant financier" description="Moteur d’analyse déterministe : aucune donnée ne quitte votre navigateur, aucun chiffre n’est inventé." />
      <div className="grid gap-5 xl:grid-cols-5">
        <Card className="flex flex-col xl:col-span-3" padded={false}>
          <div className="flex items-center gap-2 border-b border-line/10 px-5 py-3 text-xs text-muted">
            <ShieldCheck className="h-4 w-4 text-positive" /> Réponses calculées localement — mode sans IA externe
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
                        <div key={f.label} className="flex justify-between gap-3"><dt className="text-muted">{f.label}</dt><dd className="num text-right font-medium">{f.value}</dd></div>
                      ))}
                    </dl>
                  )}
                  {m.answer && <p className="mt-2 text-[11px] text-muted"><b>Source :</b> {m.answer.source}</p>}
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <div className="border-t border-line/10 p-3 sm:p-4">
            <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
              {SUGGESTED_QUESTIONS.map((s) => (
                <button key={s} onClick={() => ask(s)} className="shrink-0 rounded-full border border-line/15 bg-surface-2/60 px-3 py-1.5 text-xs text-muted transition hover:border-primary/40 hover:text-fg">{s}</button>
              ))}
            </div>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ex : combien ai-je dépensé en transport le mois dernier ?" aria-label="Votre question" />
              <Button type="submit" variant="primary" size="icon" aria-label="Envoyer" disabled={!q.trim()}><Send className="h-4 w-4" /></Button>
            </form>
          </div>
        </Card>
        <div className="space-y-5 xl:col-span-2">
          <Card title={<span className="flex items-center gap-1.5"><Sparkles className="h-4 w-4 text-cyan" /> Observations du moment</span>}>
            <InsightList insights={insights} />
          </Card>
          <Card title="À propos de l’assistant">
            <ul className="space-y-2 text-xs text-muted">
              <li>• Les réponses réutilisent les mêmes règles de calcul que le dashboard, les budgets et les rapports.</li>
              <li>• Lorsque les données sont insuffisantes, l’assistant le dit au lieu d’estimer.</li>
              <li>• Aucune recommandation d’investissement personnalisée n’est fournie.</li>
              <li>• Une extension IA est prévue : elle passerait par un proxy serveur (aucune clé dans le navigateur), ne recevrait que des agrégats et ne pourrait rien modifier sans votre confirmation.</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
