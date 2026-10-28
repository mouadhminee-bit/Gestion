/**
 * CSV : lecture tolérante (RFC 4180, séparateurs , ; tab |), normalisation des dates
 * et des montants, écriture compatible Excel (BOM UTF-8, séparateur ;).
 */
import type { ISODate } from './dates';
import { isValidISODate, makeDate } from './dates';
import type { CurrencyCode } from './money';
import { parseAmount } from './money';

export type Delimiter = ',' | ';' | '\t' | '|';

export function detectDelimiter(text: string): Delimiter {
  const sample = text.split(/\r?\n/).slice(0, 10).join('\n');
  const candidates: Delimiter[] = [';', ',', '\t', '|'];
  let best: Delimiter = ',';
  let bestScore = -1;
  for (const d of candidates) {
    const rows = parseCSV(sample, d).filter((r) => r.length > 1);
    if (!rows.length) continue;
    const counts = rows.map((r) => r.length);
    const consistent = counts.filter((c) => c === counts[0]).length;
    const score = consistent * 10 + counts[0];
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Analyse un texte CSV en lignes de cellules (gère guillemets, "" échappés, sauts de ligne). */
export function parseCSV(text: string, delimiter?: Delimiter): string[][] {
  const src = text.replace(/^﻿/, '');
  const d = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') inQuotes = true;
    else if (ch === d) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== '')).map((r) => r.map((c) => c.trim()));
}

function escapeCell(value: unknown, d: string): string {
  const s = value == null ? '' : String(value);
  // Neutralise les formules (injection CSV dans les tableurs).
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  if (safe.includes(d) || safe.includes('"') || safe.includes('\n') || safe.includes('\r')) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

export function toCSV(rows: unknown[][], delimiter: Delimiter = ';'): string {
  return '﻿' + rows.map((r) => r.map((c) => escapeCell(c, delimiter)).join(delimiter)).join('\r\n');
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export type ImportDateFormat = 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'DD-MM-YYYY' | 'DD.MM.YYYY' | 'YYYY/MM/DD' | 'DD/MM/YY';

export const IMPORT_DATE_FORMATS: ImportDateFormat[] = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD-MM-YYYY', 'DD.MM.YYYY', 'YYYY/MM/DD', 'DD/MM/YY'];

export function parseDateWithFormat(value: string, format: ImportDateFormat): ISODate | null {
  const v = value.trim().split(/[ T]/)[0];
  let m: RegExpExecArray | null;
  let y: number, mo: number, d: number;
  switch (format) {
    case 'YYYY-MM-DD':
    case 'YYYY/MM/DD':
      m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v);
      if (!m) return null;
      [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      break;
    case 'MM/DD/YYYY':
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
      if (!m) return null;
      [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
      break;
    case 'DD/MM/YY':
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(v);
      if (!m) return null;
      [d, mo, y] = [Number(m[1]), Number(m[2]), 2000 + Number(m[3])];
      break;
    default: {
      const sep = format === 'DD-MM-YYYY' ? '-' : format === 'DD.MM.YYYY' ? '\\.' : '\\/';
      m = new RegExp(`^(\\d{1,2})${sep}(\\d{1,2})${sep}(\\d{4})$`).exec(v);
      if (!m) return null;
      [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    }
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = makeDate(y, mo, d);
  return isValidISODate(iso) ? iso : null;
}

/** Détecte le format de date le plus probable (celui qui valide le plus de valeurs). */
export function detectDateFormat(values: string[]): ImportDateFormat {
  const sample = values.filter((v) => v && v.trim()).slice(0, 200);
  let best: ImportDateFormat = 'DD/MM/YYYY';
  let bestCount = -1;
  for (const f of IMPORT_DATE_FORMATS) {
    const count = sample.filter((v) => parseDateWithFormat(v, f) != null).length;
    // À égalité, DD/MM/YYYY (format par défaut) l'emporte grâce à l'ordre de la liste.
    if (count > bestCount) {
      best = f;
      bestCount = count;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Montants
// ---------------------------------------------------------------------------

export function parseImportAmount(value: string, currency: CurrencyCode): number | null {
  if (value == null || value.trim() === '') return null;
  return parseAmount(value, currency);
}

export function downloadText(filename: string, content: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
