/**
 * このアプリで書き出した PDF に、楽譜データ（JSON）を埋め込む／取り出す。
 * PDF の文書情報（Keywords）に「目印 + base64」で入れるので、PDF を開くアプリには影響しない。
 * 文書情報は圧縮されないため、取り出すときは PDF のバイト列から目印を探すだけでよい。
 */
import { Score } from '../model/score';

export const EMBED_MARK = 'MSE-SCORE1:';

export function encodeScore(score: Score): string {
  const bytes = new TextEncoder().encode(JSON.stringify(score));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return EMBED_MARK + btoa(bin);
}

/** PDF のバイト列から埋め込んだ楽譜データを探す。なければ null。 */
export function extractEmbeddedScore(pdf: Uint8Array): unknown | null {
  const text = new TextDecoder('latin1').decode(pdf);
  const at = text.lastIndexOf(EMBED_MARK);
  if (at < 0) return null;
  const m = /^[A-Za-z0-9+/=]+/.exec(text.slice(at + EMBED_MARK.length));
  if (!m) return null;
  try {
    const bin = atob(m[0]);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
