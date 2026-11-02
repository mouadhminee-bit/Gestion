/**
 * Annulation immédiate d'une restauration : bandeau global + action partagée.
 * Logique et garanties : `data/backup/undo.ts` ; limites : docs/BACKUP_RESTORE.md § 6.1.
 */
import { useCallback, useState, useSyncExternalStore } from 'react';
import { Undo2 } from 'lucide-react';
import { useApp } from '@/app/AppContext';
import { monthAfterRestore, resetUiStateAfterRestore } from '@/app/uiState';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/components/ui/Dialog';
import { errorMessage, useToast } from '@/components/ui/Toast';
import { changedSinceRestore, undoRestore, undoStore } from '@/data/backup';
import { t } from '@/i18n/core';

/** Une seule annulation à la fois, quel que soit le point d'entrée (bandeau, toast). */
let inFlight = false;

export function useRestoreUndo() {
  const slot = useSyncExternalStore(undoStore.subscribe, undoStore.get, undoStore.get);
  const { repo, today, setMonth } = useApp();
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const undo = useCallback(async () => {
    const s = undoStore.get();
    if (!s || inFlight) return;
    let changed = true;
    try {
      changed = await changedSinceRestore(repo, s);
    } catch {
      /* état actuel illisible : on suppose une modification (avertissement affiché) */
    }
    const ok = await confirm({
      title: t('bk.undo.title'),
      message: (
        <>
          <p>{t('bk.undo.message')}</p>
          {changed && <p className="mt-2 font-semibold text-warning" data-testid="undo-changed">{t('bk.undo.changed')}</p>}
        </>
      ),
      confirmLabel: t('bk.undo.confirm'),
    });
    if (!ok || inFlight || undoStore.get() !== s) return;
    inFlight = true;
    setBusy(true);
    try {
      const r = await undoRestore(repo, s);
      const m = monthAfterRestore(r.transactions, today);
      resetUiStateAfterRestore(m);
      setMonth(m);
      if (r.verified) toast.success(t('bk.undo.done'));
      else toast.warning(t('bk.undo.mismatch'));
    } catch (e) {
      // Transaction annulée : données restaurées inchangées, emplacement conservé.
      toast.error(<span className="whitespace-pre-line">{`${t('bk.undo.failed')}\n${errorMessage(e)}`}</span>);
    } finally {
      inFlight = false;
      setBusy(false);
    }
  }, [repo, today, setMonth, confirm, toast]);

  return { slot, undo, busy };
}

/**
 * Bandeau visible sur toutes les pages tant que l'annulation est possible. Volontairement
 * sans bouton « fermer » : une fermeture par mégarde ferait perdre la protection. La
 * mémoire est libérée à l'annulation, au rechargement ou à tout autre remplacement des
 * données.
 */
export function RestoreUndoBanner() {
  const { slot, undo, busy } = useRestoreUndo();
  if (!slot) return null;
  return (
    <div role="status" data-testid="restore-undo-banner" className="no-print mb-4 flex flex-col gap-2 rounded-2xl border border-cyan/30 bg-cyan/10 px-4 py-3 text-sm sm:flex-row sm:items-center">
      <p className="flex-1">{t('bk.undo.banner')}</p>
      <Button variant="outline" size="sm" icon={<Undo2 className="h-4 w-4" />} onClick={undo} disabled={busy} className="self-start sm:self-auto">
        {t('bk.undo.action')}
      </Button>
    </div>
  );
}
