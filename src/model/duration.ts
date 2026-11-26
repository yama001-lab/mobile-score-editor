/** 音価。長さはMIDIと同じティック（4分音符 = 480）で扱い、再生（ステップ2）にそのまま使える。 */

export type DurationType = 'w' | 'h' | 'q' | '8' | '16' | '32';
export const PPQ = 480;
export const DURATION_TYPES: DurationType[] = ['w', 'h', 'q', '8', '16', '32'];

export const BASE_TICKS: Record<DurationType, number> = {
  w: PPQ * 4, h: PPQ * 2, q: PPQ, '8': PPQ / 2, '16': PPQ / 4, '32': PPQ / 8,
};

export function ticksOf(duration: DurationType, dots = 0): number {
  let total = BASE_TICKS[duration];
  let add = total;
  for (let i = 0; i < dots; i++) {
    add /= 2;
    total += add;
  }
  return total;
}

export interface DurationValue {
  duration: DurationType;
  dots: number;
}

/** ティック数を、書ける音価の並びに分解する（例: 4分×3 → 付点2分）。 */
export function decompose(ticks: number): DurationValue[] {
  const out: DurationValue[] = [];
  let rest = ticks;
  while (rest >= BASE_TICKS['32']) {
    let found: DurationValue | null = null;
    for (const d of DURATION_TYPES) {
      if (d !== '32' && ticksOf(d, 1) <= rest) { found = { duration: d, dots: 1 }; break; }
      if (BASE_TICKS[d] <= rest) { found = { duration: d, dots: 0 }; break; }
    }
    if (!found) break;
    out.push(found);
    rest -= ticksOf(found.duration, found.dots);
  }
  return out;
}

export const DURATION_LABELS: Record<DurationType, string> = {
  w: '全', h: '2分', q: '4分', '8': '8分', '16': '16分', '32': '32分',
};
