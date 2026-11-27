/**
 * 楽譜が消えないための安全策。
 *
 * - ブラウザに「この保存を勝手に消さないで」と頼む（navigator.storage.persist）
 * - 全部の楽譜を1つのファイル（バックアップ）にまとめて書き出す・戻す
 * - しばらくバックアップしていなければ声をかける
 *
 * Safari はしばらく開かれていないサイトのデータを消すことがある（ホーム画面に追加したアプリは対象外）。
 * localStorage は約5MBまでなので、いっぱいになったときもバックアップを促す。
 */
import { Score } from '../model/score';
import { listScores, loadScore, migrate, saveScore } from './local';

export const BACKUP_FORMAT = 'mobile-score-editor-backup';
export const BACKUP_VERSION = 1;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: number;
  scores: Score[];
}

export function makeBackup(scores: Score[], now = Date.now()): BackupFile {
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: now, scores };
}

/** 保存してある楽譜を全部まとめる */
export function backupAll(now = Date.now()): BackupFile {
  const scores: Score[] = [];
  for (const s of listScores()) {
    const sc = loadScore(s.id);
    if (sc) scores.push(sc);
  }
  return makeBackup(scores, now);
}

/** バックアップのファイル、または1曲だけの楽譜ファイル（.json）を読む */
export function parseBackup(text: string): Score[] {
  const data = JSON.parse(text);
  if (data && data.format === BACKUP_FORMAT) {
    if (!Array.isArray(data.scores)) throw new Error('バックアップの中身が壊れています');
    return data.scores.map((s: unknown) => migrate(s));
  }
  return [migrate(data)];
}

export interface RestoreResult {
  added: number;
  updated: number;
  skipped: number;
}

/**
 * バックアップの楽譜を保存に戻す。同じ楽譜（同じ id）がすでにあれば、新しいほうを残す
 * （今ある楽譜の方が新しければ上書きしない）。
 */
export function planRestore(
  existing: { id: string; updatedAt: number }[],
  incoming: Score[],
): { save: Score[]; result: RestoreResult } {
  const have = new Map(existing.map((s) => [s.id, s.updatedAt]));
  const save: Score[] = [];
  const result: RestoreResult = { added: 0, updated: 0, skipped: 0 };
  const seen = new Set<string>();
  for (const s of incoming) {
    if (!s.id || seen.has(s.id)) { result.skipped++; continue; }
    seen.add(s.id);
    const cur = have.get(s.id);
    if (cur === undefined) { save.push(s); result.added++; }
    else if ((s.updatedAt || 0) > cur) { save.push(s); result.updated++; }
    else result.skipped++;
  }
  return { save, result };
}

export function restoreBackup(incoming: Score[]): RestoreResult {
  const { save, result } = planRestore(listScores(), incoming);
  for (const s of save) saveScore(s, { makeLast: false });
  return result;
}

// ---------- バックアップの声かけ ----------

export const REMIND_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface BackupState {
  /** 最後にバックアップした時刻（未実施なら 0） */
  backupAt: number;
  /** 最後に声をかけた時刻（なければ 0） */
  remindedAt: number;
  /** はじめてこのアプリを開いた時刻 */
  firstUseAt: number;
}

/**
 * 声をかけるか。バックアップのあとに書き換えた楽譜があり、
 * バックアップ（またはまだなら使い始め）からも前の声かけからも7日たっていたら。
 */
export function shouldRemindBackup(state: BackupState, latestEditAt: number, now = Date.now()): boolean {
  if (!latestEditAt || latestEditAt <= state.backupAt) return false;
  const since = Math.max(state.backupAt || state.firstUseAt, state.remindedAt);
  return now - since >= REMIND_AFTER_MS;
}

/** バックアップのあとに書き換えた楽譜の数 */
export function changedSinceBackup(list: { updatedAt: number }[], backupAt: number): number {
  return list.filter((s) => s.updatedAt > backupAt).length;
}

// ---------- ブラウザの保存の守り ----------

export type PersistState = 'persisted' | 'not-persisted' | 'unsupported';

/** 保存を消さないようブラウザに頼む。すでに許されていればそのまま。 */
export async function requestPersist(): Promise<PersistState> {
  const st = (navigator as Navigator).storage;
  if (!st || typeof st.persist !== 'function') return 'unsupported';
  try {
    if (typeof st.persisted === 'function' && await st.persisted()) return 'persisted';
    return (await st.persist()) ? 'persisted' : 'not-persisted';
  } catch {
    return 'unsupported';
  }
}

/** ホーム画面から開いているか（Safari はホーム画面のアプリのデータを日数で消さない） */
export function isStandalone(): boolean {
  try {
    return window.matchMedia?.('(display-mode: standalone)').matches
      || (navigator as unknown as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

/** localStorage のうち、このアプリが使っている量（文字数×2バイトの目安） */
export function localUsageBytes(prefix = 'score-editor:'): number {
  let n = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) n += (k.length + (localStorage.getItem(k)?.length ?? 0)) * 2;
    }
  } catch { /* 読めない環境 */ }
  return n;
}

/** localStorage はおおよそ5MBまで（Safari・Chrome） */
export const LOCAL_LIMIT_BYTES = 5 * 1024 * 1024;

export function backupFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `楽譜バックアップ-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`;
}

/**
 * ファイルを端末に保存する。iPad など共有シートがあるときはそれを開き（「"ファイル"に保存」で iCloud Drive などへ）、
 * なければダウンロードする。保存できたら true、取り消されたら false。
 */
export async function saveFileToDevice(blob: Blob, name: string): Promise<boolean> {
  const file = typeof File !== 'undefined' ? new File([blob], name, { type: blob.type }) : null;
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  const touch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  if (file && touch && nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: name });
      return true;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return false;
      // 共有できなければダウンロードに切り替える
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return true;
}

export function isQuotaError(err: unknown): boolean {
  const e = err as { name?: string; code?: number };
  return e?.name === 'QuotaExceededError' || e?.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e?.code === 22;
}
