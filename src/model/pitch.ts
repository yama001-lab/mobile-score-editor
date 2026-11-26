/** 音高の表現と変換。鍵盤入力（MIDI番号）・手書き認識（五線上の位置）・再生のいずれからも使う。 */

export const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
export type Step = (typeof STEPS)[number];

export interface Pitch {
  step: Step;
  /** 変化記号: -2=ダブルフラット, -1=フラット, 0=ナチュラル, 1=シャープ, 2=ダブルシャープ */
  alter: number;
  /** 科学的音名のオクターブ（中央ド = C4） */
  octave: number;
}

const STEP_SEMITONES: Record<Step, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_ORDER: Step[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER: Step[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

/** MIDI番号（中央ド = 60）。再生で使う。 */
export function toMidi(p: Pitch): number {
  return (p.octave + 1) * 12 + STEP_SEMITONES[p.step] + p.alter;
}

/** 白鍵の通し番号（C0 = 0）。五線上の縦位置と1対1に対応する。 */
export function diatonicIndex(p: Pick<Pitch, 'step' | 'octave'>): number {
  return p.octave * 7 + STEPS.indexOf(p.step);
}

export function fromDiatonic(index: number, alter = 0): Pitch {
  const octave = Math.floor(index / 7);
  const step = STEPS[((index % 7) + 7) % 7];
  return { step, alter, octave };
}

/** 調号（シャープ数。フラットは負）で、その音名に付く変化。 */
export function keyAlter(fifths: number, step: Step): number {
  if (fifths > 0) return SHARP_ORDER.slice(0, fifths).includes(step) ? 1 : 0;
  if (fifths < 0) return FLAT_ORDER.slice(0, -fifths).includes(step) ? -1 : 0;
  return 0;
}

/** 五線上の位置から、調号を考慮した音高を作る。 */
export function pitchAtPosition(index: number, fifths: number): Pitch {
  const p = fromDiatonic(index);
  p.alter = keyAlter(fifths, p.step);
  return p;
}

/** MIDI番号から、調に合った綴りの音高を作る（鍵盤入力用）。 */
export function fromMidi(midi: number, fifths = 0): Pitch {
  const pc = ((midi % 12) + 12) % 12;
  const candidates: Pitch[] = [];
  for (const step of STEPS) {
    for (const alter of [0, 1, -1]) {
      if ((((STEP_SEMITONES[step] + alter) % 12) + 12) % 12 === pc) {
        const octave = Math.floor((midi - alter - STEP_SEMITONES[step]) / 12) - 1;
        candidates.push({ step, alter, octave });
      }
    }
  }
  const inKey = candidates.find((c) => c.alter === keyAlter(fifths, c.step));
  if (inKey) return inKey;
  const natural = candidates.find((c) => c.alter === 0);
  if (natural) return natural;
  const preferred = fifths < 0 ? -1 : 1;
  return candidates.find((c) => c.alter === preferred) ?? candidates[0];
}

export function samePitch(a: Pitch, b: Pitch): boolean {
  return a.step === b.step && a.alter === b.alter && a.octave === b.octave;
}

export function comparePitch(a: Pitch, b: Pitch): number {
  return diatonicIndex(a) - diatonicIndex(b) || a.alter - b.alter;
}

const KEY_NAMES: Record<number, string> = {
  [-7]: 'Cb', [-6]: 'Gb', [-5]: 'Db', [-4]: 'Ab', [-3]: 'Eb', [-2]: 'Bb', [-1]: 'F',
  0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F#', 7: 'C#',
};
const KEY_LABELS_JA: Record<number, string> = {
  [-7]: '変ハ長調', [-6]: '変ト長調', [-5]: '変ニ長調', [-4]: '変イ長調', [-3]: '変ホ長調', [-2]: '変ロ長調', [-1]: 'ヘ長調',
  0: 'ハ長調', 1: 'ト長調', 2: 'ニ長調', 3: 'イ長調', 4: 'ホ長調', 5: 'ロ長調', 6: '嬰ヘ長調', 7: '嬰ハ長調',
};
export const keyName = (fifths: number): string => KEY_NAMES[fifths] ?? 'C';
export const keyLabelJa = (fifths: number): string => KEY_LABELS_JA[fifths] ?? 'ハ長調';

export function accidentalSymbol(alter: number): string {
  return ({ [-2]: 'bb', [-1]: 'b', 0: 'n', 1: '#', 2: '##' } as Record<number, string>)[alter] ?? 'n';
}
