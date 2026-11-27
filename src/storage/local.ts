/** ブラウザ内（localStorage）への保存。サーバーは使わない。 */
import { SCHEMA_VERSION, Score } from '../model/score';

const PREFIX = 'score-editor:';
const INDEX_KEY = PREFIX + 'index';
const LAST_KEY = PREFIX + 'last';

export interface ScoreSummary {
  id: string;
  title: string;
  updatedAt: number;
}

function readIndex(): ScoreSummary[] {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeIndex(list: ScoreSummary[]) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(list));
}

export function listScores(): ScoreSummary[] {
  return readIndex().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveScore(score: Score, opts: { makeLast?: boolean } = {}): void {
  localStorage.setItem(PREFIX + 'score:' + score.id, JSON.stringify(score));
  const list = readIndex().filter((s) => s.id !== score.id);
  list.push({ id: score.id, title: score.title, updatedAt: score.updatedAt });
  writeIndex(list);
  if (opts.makeLast !== false) localStorage.setItem(LAST_KEY, score.id);
}

export function loadScore(id: string): Score | null {
  const raw = localStorage.getItem(PREFIX + 'score:' + id);
  if (!raw) return null;
  try {
    return migrate(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function deleteScore(id: string): void {
  localStorage.removeItem(PREFIX + 'score:' + id);
  writeIndex(readIndex().filter((s) => s.id !== id));
  if (localStorage.getItem(LAST_KEY) === id) localStorage.removeItem(LAST_KEY);
}

export function lastScoreId(): string | null {
  return localStorage.getItem(LAST_KEY);
}

/** 古い形式のデータを今の形式に直す。schemaVersion を上げたらここに変換を足す。 */
export function migrate(data: unknown): Score {
  const s = data as Score;
  if (!s || typeof s !== 'object' || !Array.isArray(s.parts)) throw new Error('楽譜データではありません');
  if (!s.schemaVersion) s.schemaVersion = SCHEMA_VERSION;
  return s;
}
