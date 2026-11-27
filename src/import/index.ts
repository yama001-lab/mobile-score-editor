/**
 * 取り込みの入口。ファイルの中身を見て、MusicXML（.musicxml / .xml / .mxl）、
 * このアプリの PDF、楽譜ファイル（.json）を Score に変換する。
 * ほかの PDF や写真は、ここでは読み取れないので kind: 'needs-omr' を返す（画面で Audiveris の使い方を案内する）。
 */
import { Score } from '../model/score';
import { migrate } from '../storage/local';
import { extractEmbeddedScore } from './embed';
import { parseMusicXml } from './musicxml';

export type ImportOutcome =
  | { kind: 'score'; score: Score; warnings: string[]; source: 'musicxml' | 'pdf' | 'json' }
  | { kind: 'needs-omr'; reason: 'pdf' | 'image' };

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const isPdf = (b: Uint8Array) => new TextDecoder('latin1').decode(b.subarray(0, 1024)).includes('%PDF-');
const isImage = (name: string, type: string) => type.startsWith('image/') || /\.(png|jpe?g|heic|heif|gif|webp|tiff?|bmp)$/i.test(name);

export async function importBytes(bytes: Uint8Array, name: string, type = ''): Promise<ImportOutcome> {
  if (isPdf(bytes)) {
    const data = extractEmbeddedScore(bytes);
    if (!data) return { kind: 'needs-omr', reason: 'pdf' };
    return { kind: 'score', score: migrate(data), warnings: [], source: 'pdf' };
  }
  if (isImage(name, type)) return { kind: 'needs-omr', reason: 'image' };
  if (isZip(bytes)) {
    const { unzipMusicXml } = await import('./mxl');
    const r = parseMusicXml(unzipMusicXml(bytes));
    return { kind: 'score', ...r, source: 'musicxml' };
  }
  const text = new TextDecoder().decode(bytes).replace(/^﻿/, '');
  const head = text.trimStart();
  if (head.startsWith('{')) return { kind: 'score', score: migrate(JSON.parse(text)), warnings: [], source: 'json' };
  if (head.startsWith('<')) {
    const r = parseMusicXml(text);
    return { kind: 'score', ...r, source: 'musicxml' };
  }
  throw new Error('対応していない種類のファイルです（PDF・MusicXML・.mxl・.json に対応）');
}

export async function importFile(file: File): Promise<ImportOutcome> {
  return importBytes(new Uint8Array(await file.arrayBuffer()), file.name, file.type);
}
