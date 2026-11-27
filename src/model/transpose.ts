/**
 * 移調。音程は「五線上で何段動かすか（白鍵の数）」と「何半音動かすか」の組で表す。
 * 両方を持つので、長3度上（2段・4半音）なら ド→ミ、レ→ファ♯ のように綴りが正しくなる。
 */
import { Pitch, STEPS, Step, diatonicIndex, fromDiatonic, fromMidi, keyAlter, toMidi } from './pitch';

export interface Interval {
  /** 白鍵の数（上が正） */
  steps: number;
  /** 半音の数（上が正） */
  semitones: number;
}

/** 画面で選べる音程（上向き）。下向きは符号を反対にする */
export const INTERVALS: { label: string; steps: number; semitones: number }[] = [
  { label: '短2度（半音）', steps: 1, semitones: 1 },
  { label: '長2度（全音）', steps: 1, semitones: 2 },
  { label: '短3度', steps: 2, semitones: 3 },
  { label: '長3度', steps: 2, semitones: 4 },
  { label: '完全4度', steps: 3, semitones: 5 },
  { label: '増4度', steps: 3, semitones: 6 },
  { label: '減5度', steps: 4, semitones: 6 },
  { label: '完全5度', steps: 4, semitones: 7 },
  { label: '短6度', steps: 5, semitones: 8 },
  { label: '長6度', steps: 5, semitones: 9 },
  { label: '短7度', steps: 6, semitones: 10 },
  { label: '長7度', steps: 6, semitones: 11 },
  { label: '完全8度（1オクターブ）', steps: 7, semitones: 12 },
];

export function transposePitch(p: Pitch, iv: Interval): Pitch {
  const target = toMidi(p) + iv.semitones;
  const np = fromDiatonic(diatonicIndex(p) + iv.steps);
  const alter = target - toMidi({ ...np, alter: 0 });
  if (alter >= -2 && alter <= 2) return { ...np, alter };
  // ダブルシャープを超えるような綴りになるときは、近い綴りに直す
  return fromMidi(target);
}

const STEP_FIFTHS: Record<Step, number> = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, F: -1 };

/** 長調の主音（調号のシャープ数から） */
export function tonicOf(fifths: number, octave = 4): Pitch {
  const step = STEPS[(((fifths * 4) % 7) + 7) % 7];
  return { step, alter: keyAlter(fifths, step), octave };
}

/** 主音の綴りから長調の調号（シャープ数）。範囲外（例：嬰ト長調 = 8）もそのまま返す */
export function fifthsOfTonic(p: Pick<Pitch, 'step' | 'alter'>): number {
  return STEP_FIFTHS[p.step] + 7 * p.alter;
}

/**
 * 楽譜全体を移調したときの新しい調号。調号が7つを超えるときは、同じ高さで綴りの違う音程
 * （例：増1度 → 短2度）に替えて、異名同音の調にする。音符もその音程で動かせば調号と合う。
 */
export function transposeKey(fifths: number, iv: Interval): { fifths: number; interval: Interval } {
  const keyAfter = (c: Interval) => fifthsOfTonic(transposePitch(tonicOf(fifths), c));
  const f = keyAfter(iv);
  if (Math.abs(f) <= 7) return { fifths: f, interval: iv };
  for (const c of [{ ...iv, steps: iv.steps + 1 }, { ...iv, steps: iv.steps - 1 }]) {
    const g = keyAfter(c);
    if (Math.abs(g) <= 7) return { fifths: g, interval: c };
  }
  return { fifths: Math.max(-7, Math.min(7, f)), interval: iv };
}

/** 調 from から調 to への音程。dir：up=上へ、down=下へ、nearest=近い方へ */
export function intervalBetweenKeys(from: number, to: number, dir: 'up' | 'down' | 'nearest'): Interval {
  const a = tonicOf(from);
  const b = tonicOf(to);
  let steps = diatonicIndex(b) - diatonicIndex(a);
  let semitones = toMidi(b) - toMidi(a);
  const up = () => { while (semitones < 0 || (semitones === 0 && steps < 0)) { steps += 7; semitones += 12; } };
  const down = () => { while (semitones > 0 || (semitones === 0 && steps > 0)) { steps -= 7; semitones -= 12; } };
  up();
  while (semitones >= 12) { steps -= 7; semitones -= 12; }
  if (dir === 'down' || (dir === 'nearest' && semitones > 6)) down();
  return { steps, semitones };
}
