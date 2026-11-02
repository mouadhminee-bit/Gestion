/**
 * Encodage des pièces jointes dans la sauvegarde JSON (base64).
 *
 * Le contenu binaire (`Blob`) n'est pas sérialisable en JSON : il est converti en base64
 * à l'export et reconstitué à la restauration. Surcoût de taille : ~33 %.
 */
import type { Attachment } from '@/domain/types';
import type { SerializedAttachment } from './format';

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Taille décodée d'une chaîne base64 valide, ou `null` si la chaîne est invalide. */
export function base64DecodedSize(b64: string): number | null {
  if (b64.length % 4 !== 0 || !B64_RE.test(b64)) return null;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  // Repli (anciens navigateurs / environnements sans Blob.arrayBuffer).
  return new Uint8Array(await new Response(blob).arrayBuffer());
}

export async function serializeAttachment(a: Attachment): Promise<SerializedAttachment> {
  const blob = a.blob as Blob | undefined;
  const data = blob && typeof blob === 'object' && 'size' in blob ? bytesToBase64(await blobBytes(blob)) : null;
  return { id: a.id, userId: a.userId, name: a.name, mimeType: a.mimeType, size: a.size, createdAt: a.createdAt, data };
}

/** Reconstitue la pièce jointe (le fichier a été validé au préalable). */
export function deserializeAttachment(s: SerializedAttachment, userId: string): Attachment {
  const bytes = base64ToBytes(s.data ?? '');
  return { id: s.id, userId, name: s.name, mimeType: s.mimeType, size: s.size, createdAt: s.createdAt, blob: new Blob([bytes], { type: s.mimeType }) };
}
