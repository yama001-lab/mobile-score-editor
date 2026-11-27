/** 楽譜を「いつ・どの高さを・どれだけ鳴らすか」の一覧にする。音は出さないので単体テストできる。 */
import { PPQ } from '../model/duration';
import { toMidi } from '../model/pitch';
import { Instrument, Score, eventTicks, measureCapacity, tempoAt } from '../model/score';
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
 * fromMeasure 小節目（0始まり）から最後まで。タイでつながった同じ高さの音は1つの長い音にする。
 * テンポは小節ごと（途中のテンポ変更は小節の頭から効く）。
 */
export function buildSchedule(score: Score, fromMeasure = 0): Schedule {
  const cap = measureCapacity(score.timeSignature);
  const count = score.parts[0].measures.length;
  // 各小節の開始時刻と、1ティックの秒数
  const starts: number[] = [];
  const spts: number[] = [];
  let t = 0;
  for (let mi = fromMeasure; mi < count; mi++) {
    starts[mi] = t;
    spts[mi] = secondsPerTick(tempoAt(score, mi));
    t += cap * spts[mi];
  }
  // フェルマータ：その音の終わりで、全パートそろって音の長さぶん待つ
  const pauses = fermataPauses(score, fromMeasure, cap, (mi, ticks) => ticks * spts[mi]);
  const pauseBefore = (mi: number, tick: number) => {
    let s = 0;
    for (const p of pauses) if (p.measure < mi || (p.measure === mi && p.tick <= tick)) s += p.seconds;
    return s;
  };
  const length = t + pauses.reduce((a, p) => a + p.seconds, 0);
  const timeAt = (mi: number, tick: number) => starts[mi] + tick * spts[mi] + pauseBefore(mi, tick);

  const notes: ScheduledNote[] = [];
  const marks: ScheduledMark[] = [];
  score.parts.forEach((part, partIndex) => {
    // タイで次へ続く音（MIDI番号 → 鳴らしている音）
    let tied = new Map<number, ScheduledNote>();
    const dyn = new DynamicsTrack(score, partIndex);
    for (let mi = fromMeasure; mi < count; mi++) {
      let tick = 0;
      part.measures[mi].events.forEach((ev, eventIndex) => {
        const len = eventTicks(ev);
        const start = timeAt(mi, tick);
        const end = timeAt(mi, tick + len);
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
    }
  });
  notes.sort((a, b) => a.time - b.time);
  marks.sort((a, b) => a.time - b.time || a.partIndex - b.partIndex);
  return { notes, marks, length };
}
