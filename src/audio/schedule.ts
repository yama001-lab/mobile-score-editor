/** 楽譜を「いつ・どの高さを・どれだけ鳴らすか」の一覧にする。音は出さないので単体テストできる。 */
import { PPQ } from '../model/duration';
import { toMidi } from '../model/pitch';
import { Instrument, Score, capacityAt, eventTicks, playOrder, tempoAt } from '../model/score';
import { DynamicsTrack, fermataPauses, noteVelocity, shortenFor } from './expression';

export interface ScheduledNote {
  /** 再生開始からの秒 */
  time: number;
  duration: number;
  midi: number;
  instrument: Instrument;
  partIndex: number;
  /** 強さ 0〜1.2 くらい（強弱記号・アクセントから）。省略時は既定の強さ */
  velocity?: number;
}

/** 再生中の位置を楽譜上に示すための目印 */
export interface ScheduledMark {
  time: number;
  partIndex: number;
  measureIndex: number;
  eventIndex: number;
}

export interface Schedule {
  notes: ScheduledNote[];
  marks: ScheduledMark[];
  /** 全体の長さ（秒） */
  length: number;
}

export function secondsPerTick(tempo: number) {
  return 60 / (tempo * PPQ);
}

/**
 * fromMeasure 小節目（0始まり）から最後まで。リピート記号と番号付きカッコをたどって、同じ小節を何度も鳴らす。
 * タイでつながった同じ高さの音は1つの長い音にする。テンポは小節ごと（途中のテンポ変更は小節の頭から効く）。
 */
export function buildSchedule(score: Score, fromMeasure = 0): Schedule {
  const full = playOrder(score);
  // 再生を始める小節が最初に出てくる所から（なければその後ろの小節から）
  let k0 = full.indexOf(fromMeasure);
  if (k0 < 0) k0 = full.findIndex((m) => m > fromMeasure);
  const order = k0 < 0 ? [] : full.slice(k0);
  // 演奏順の各小節の開始時刻と、1ティックの秒数
  const starts: number[] = [];
  const spts: number[] = [];
  let t = 0;
  // フェルマータ：その音の終わりで、全パートそろって音の長さぶん待つ（リピートで同じ小節を弾くたびに待つ）
  const pauses = fermataPauses(score, 0, (mi) => capacityAt(score, mi), (mi, ticks) => ticks * secondsPerTick(tempoAt(score, mi)));
  const pauseBefore = (mi: number, tick: number) => {
    let s = 0;
    for (const p of pauses) if (p.measure === mi && p.tick <= tick) s += p.seconds;
    return s;
  };
  order.forEach((mi, k) => {
    starts[k] = t;
    spts[k] = secondsPerTick(tempoAt(score, mi));
    t += capacityAt(score, mi) * spts[k] + pauseBefore(mi, Infinity);
  });
  const length = t;
  const timeAt = (k: number, tick: number) => starts[k] + tick * spts[k] + pauseBefore(order[k], tick);

  const notes: ScheduledNote[] = [];
  const marks: ScheduledMark[] = [];
  score.parts.forEach((part, partIndex) => {
    // タイで次へ続く音（MIDI番号 → 鳴らしている音）
    let tied = new Map<number, ScheduledNote>();
    const dyn = new DynamicsTrack(score, partIndex);
    order.forEach((mi, k) => {
      let tick = 0;
      part.measures[mi].events.forEach((ev, eventIndex) => {
        const len = eventTicks(ev);
        const start = timeAt(k, tick);
        const end = timeAt(k, tick + len);
        marks.push({ time: start, partIndex, measureIndex: mi, eventIndex });
        const next = new Map<number, ScheduledNote>();
        const level = dyn.levelAt(ev);
        if (ev.kind === 'note') {
          // スタッカートなどは鳴らす長さを縮める（タイの途中は縮めない）
          const playEnd = ev.tie ? end : start + (end - start) * shortenFor(ev);
          for (const p of ev.pitches) {
            const midi = toMidi(p);
            let n = tied.get(midi);
            if (n) n.duration = playEnd - n.time;
            else {
              n = { time: start, duration: playEnd - start, midi, instrument: part.instrument, partIndex, velocity: noteVelocity(ev, level) };
              notes.push(n);
            }
            if (ev.tie) next.set(midi, n);
          }
        }
        tied = next;
        tick += len;
      });
    });
  });
  notes.sort((a, b) => a.time - b.time);
  marks.sort((a, b) => a.time - b.time || a.partIndex - b.partIndex);
  return { notes, marks, length };
}
