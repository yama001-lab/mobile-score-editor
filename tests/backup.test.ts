// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createScore } from '../src/model/score';
import { listScores, loadScore, saveScore } from '../src/storage/local';
import {
  BACKUP_FORMAT, REMIND_AFTER_MS, backupAll, backupFileName, changedSinceBackup, isQuotaError,
  parseBackup, planRestore, restoreBackup, shouldRemindBackup,
} from '../src/storage/backup';

const DAY = 24 * 60 * 60 * 1000;

describe('バックアップ', () => {
  beforeEach(() => localStorage.clear());

  it('保存してある楽譜を全部まとめ、そのまま読み戻せる', () => {
    const a = createScore({ title: 'A' });
    const b = createScore({ title: 'B', grandStaff: true });
    saveScore(a);
    saveScore(b);
    const data = backupAll(123);
    expect(data.format).toBe(BACKUP_FORMAT);
    expect(data.createdAt).toBe(123);
    expect(data.scores.map((s) => s.title).sort()).toEqual(['A', 'B']);
    const back = parseBackup(JSON.stringify(data));
    expect(back.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(back.find((s) => s.id === b.id)!.parts.length).toBe(2);
  });

  it('1曲だけの楽譜ファイル（.json）も読める', () => {
    const a = createScore({ title: '一曲' });
    expect(parseBackup(JSON.stringify(a))[0].title).toBe('一曲');
  });

  it('楽譜でないファイルはエラーにする', () => {
    expect(() => parseBackup('{"hello":1}')).toThrow();
    expect(() => parseBackup(JSON.stringify({ format: BACKUP_FORMAT, scores: 'x' }))).toThrow();
  });

  it('戻すときは新しいほうを残す', () => {
    const s = (id: string, updatedAt: number) => ({ ...createScore(), id, updatedAt });
    const { save, result } = planRestore(
      [{ id: 'old', updatedAt: 100 }, { id: 'new', updatedAt: 500 }],
      [s('old', 200), s('new', 300), s('fresh', 1), s('fresh', 2)],
    );
    expect(save.map((x) => x.id)).toEqual(['old', 'fresh']);
    expect(result).toEqual({ added: 1, updated: 1, skipped: 2 });
  });

  it('戻しても開いている楽譜（最後に開いた楽譜）は変わらない', () => {
    const cur = createScore({ title: '今の' });
    saveScore(cur);
    const other = createScore({ title: 'ほか' });
    const r = restoreBackup([other]);
    expect(r.added).toBe(1);
    expect(listScores().length).toBe(2);
    expect(loadScore(other.id)!.title).toBe('ほか');
    expect(localStorage.getItem('score-editor:last')).toBe(cur.id);
  });
});

describe('バックアップの声かけ', () => {
  const now = 100 * DAY;
  it('書き換えがなければ声をかけない', () => {
    expect(shouldRemindBackup({ backupAt: now - 30 * DAY, remindedAt: 0, firstUseAt: 0 }, now - 31 * DAY, now)).toBe(false);
  });
  it('バックアップから7日たって書き換えがあれば声をかける', () => {
    const st = { backupAt: now - REMIND_AFTER_MS, remindedAt: 0, firstUseAt: 0 };
    expect(shouldRemindBackup(st, now - DAY, now)).toBe(true);
    expect(shouldRemindBackup({ ...st, backupAt: now - 6 * DAY }, now - DAY, now)).toBe(false);
  });
  it('一度もバックアップしていなければ使い始めから7日で声をかけ、声をかけたら7日あける', () => {
    expect(shouldRemindBackup({ backupAt: 0, remindedAt: 0, firstUseAt: now - 2 * DAY }, now, now)).toBe(false);
    expect(shouldRemindBackup({ backupAt: 0, remindedAt: 0, firstUseAt: now - 8 * DAY }, now, now)).toBe(true);
    expect(shouldRemindBackup({ backupAt: 0, remindedAt: now - 3 * DAY, firstUseAt: now - 30 * DAY }, now, now)).toBe(false);
  });
  it('バックアップのあとに書き換えた曲を数える', () => {
    expect(changedSinceBackup([{ updatedAt: 5 }, { updatedAt: 15 }, { updatedAt: 20 }], 10)).toBe(2);
  });
});

describe('その他', () => {
  it('ファイル名に日時が入る', () => {
    expect(backupFileName(new Date(2026, 10, 27, 9, 5))).toBe('楽譜バックアップ-20261127-0905.json');
  });
  it('保存場所がいっぱいのエラーを見分ける', () => {
    expect(isQuotaError({ name: 'QuotaExceededError' })).toBe(true);
    expect(isQuotaError(new Error('x'))).toBe(false);
  });
});
