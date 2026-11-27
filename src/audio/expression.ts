/**
 * 再生の表情づけ（強弱記号・クレッシェンド/ディミヌエンド・アクセント・スタッカート・フェルマータ）。
 * 簡単なものだけ：強さは音量の倍率、スタッカートは長さを半分、フェルマータは音の長さぶん止まる。
 */
import { flatEvents, resolveSpanners } from '../model/marks';
import { Dynamic, MusicEvent, Score, eventTicks } from '../model/score';

/** 強弱記号ごとの強さ（playNote の velocity） */
export const DYNAMIC_LEVELS: Record<Exclude<Dynamic, 'sfz' | 'fp'>, number> = {
  pp: 0.3, p: 0.45, mp: 0.6, mf: 0.75, f: 0.95, ff: 1.15,
};
const DEFAULT_LEVEL = 0.75;
const HAIRPIN_STEP = 0.25;

/** 強弱記号が付いたあとに続く強さ（sfz は前の強さに戻る、fp は p になる） */
function levelAfter(d: Dynamic, prev: number): number {
  if (d === 'sfz') return prev;
  if (d === 'fp') return DYNAMIC_LEVELS.p;
  return DYNAMIC_LEVELS[d];
}

/** その音符だけの強さ */
function levelOn(d: Dynamic, prev: number): number {
  if (d === 'sfz') return Math.max(1.15, prev * 1.3);
  if (d === 'fp') return DYNAMIC_LEVELS.f;
  return DYNAMIC_LEVELS[d];
}

/** パートの各音符の強さを、強弱記号とヘアピンから先に計算しておく */
export class DynamicsTrack {
  private levels = new Map<string, number>();

  constructor(score: Score, partIndex: number) {
    // 強さは声部1でたどる（声部2の音は同じ時刻の声部1の強さで鳴らす。声部2の強弱記号はその音だけ）
    const seq = flatEvents(score, partIndex);
    const hairpins = resolveSpanners(score)
      .filter((r) => r.partIndex === partIndex && r.voice === 0 && r.spanner.kind !== 'slur')
      .sort((a, b) => a.from.index - b.from.index);
    let cur = DEFAULT_LEVEL;
    let hp = 0;
    let ramp: { from: number; to: number; start: number; end: number } | null = null;
    for (let i = 0; i < seq.length; i++) {
      const ev = seq[i].ev;
      if (ev.dynamic) {
        this.levels.set(ev.id, levelOn(ev.dynamic, cur));
        cur = levelAfter(ev.dynamic, cur);
        ramp = null;
      }
      while (hp < hairpins.length && hairpins[hp].from.index <= i) {
        const h = hairpins[hp++];
        if (h.from.index !== i) continue;
        // 目標：終わりの音符か、そのすぐ次の音符の強弱記号。なければ一段階
        const target = [seq[h.to.index], seq[h.to.index + 1]].find((fe) => fe?.ev.dynamic)?.ev.dynamic;
        const dir = h.spanner.kind === 'cresc' ? 1 : -1;
        let to = target ? levelOn(target, cur) : cur + dir * HAIRPIN_STEP;
        if (dir > 0 ? to <= cur : to >= cur) to = cur + dir * HAIRPIN_STEP;
        to = Math.max(0.2, Math.min(1.25, to));
        ramp = { from: cur, to, start: h.from.index, end: h.to.index };
      }
      if (ramp && !ev.dynamic) {
        const k = ramp.end === ramp.start ? 1 : (i - ramp.start) / (ramp.end - ramp.start);
        cur = ramp.from + (ramp.to - ramp.from) * Math.min(1, k);
        if (i >= ramp.end) ramp = null;
      }
      if (!this.levels.has(ev.id)) this.levels.set(ev.id, cur);
    }
  }

  levelAt(ev: MusicEvent): number {
    return this.levels.get(ev.id) ?? DEFAULT_LEVEL;
  }
}

/** アクセントなどを掛けた強さ */
export function noteVelocity(ev: MusicEvent, level: number): number {
  const a = ev.articulations ?? [];
  let v = level;
  if (a.includes('marcato')) v *= 1.35;
  else if (a.includes('accent')) v *= 1.25;
  else if (a.includes('tenuto')) v *= 1.05;
  return Math.min(1.4, v);
}

/** 鳴らす長さの割合（スタッカートは半分、スタッカート＋テヌートは 3/4） */
export function shortenFor(ev: MusicEvent): number {
  const a = ev.articulations ?? [];
  if (!a.includes('staccato')) return 1;
  return a.includes('tenuto') ? 0.75 : 0.5;
}

export interface FermataPause {
  measure: number;
  /** 小節の頭からのティック（フェルマータの音の終わり） */
  tick: number;
  seconds: number;
}

/** フェルマータで止まる所。同じ位置に複数のパートで付いていたら長いほう */
export function fermataPauses(
  score: Score, fromMeasure: number, capacity: number | ((measure: number) => number), secondsOf: (measure: number, ticks: number) => number,
): FermataPause[] {
  const map = new Map<string, FermataPause>();
  for (const part of score.parts) {
    part.measures.forEach((m, mi) => {
      if (mi < fromMeasure) return;
      let tick = 0;
      for (const ev of m.events) {
        const len = eventTicks(ev);
        tick += len;
        if (!ev.articulations?.includes('fermata')) continue;
        const cap = typeof capacity === 'number' ? capacity : capacity(mi);
        const key = `${mi}:${Math.min(tick, cap)}`;
        const seconds = secondsOf(mi, len);
        const old = map.get(key);
        if (!old || old.seconds < seconds) map.set(key, { measure: mi, tick: Math.min(tick, cap), seconds });
      }
    });
  }
  return [...map.values()];
}
