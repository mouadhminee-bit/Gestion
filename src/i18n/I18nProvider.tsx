/**
 * Chargement de la langue active et changement de langue.
 * L'application est remontée (clé = langue) pour que chaque texte, y compris ceux
 * calculés par le domaine, soit régénéré dans la nouvelle langue.
 */
import { createContext, Fragment, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Lang } from './languages';
import { isLang, languageInfo } from './languages';
import { loadMessages, setLanguage } from './core';
import { registerEnglishKeywords } from '@/domain/assistant';

const STORAGE_KEY = 'nexora.lang';

interface I18nState {
  lang: Lang;
  changeLanguage: (lang: Lang) => Promise<void>;
}

const I18nCtx = createContext<I18nState>({ lang: 'fr', changeLanguage: async () => {} });

export function useI18n() {
  return useContext(I18nCtx);
}

function storedLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isLang(v)) return v;
  } catch {
    /* stockage indisponible */
  }
  return 'fr';
}

function applyDocument(lang: Lang) {
  const root = document.documentElement;
  root.lang = lang;
  root.dir = languageInfo(lang).dir;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(storedLang);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    setLanguage(lang).then(() => {
      if (!alive) return;
      applyDocument(lang);
      setReady(true);
    });
    // Mots-clés anglais de l'assistant : acceptés quelle que soit la langue de l'interface.
    loadMessages('en').then(registerEnglishKeywords).catch(() => {});
    return () => {
      alive = false;
    };
  }, [lang]);

  const changeLanguage = useCallback(async (next: Lang) => {
    if (!isLang(next)) return;
    await setLanguage(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    applyDocument(next);
    setLang(next);
  }, []);

  if (!ready) return null;
  return (
    <I18nCtx.Provider value={{ lang, changeLanguage }}>
      <Fragment key={lang}>{children}</Fragment>
    </I18nCtx.Provider>
  );
}
