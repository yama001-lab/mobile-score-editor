/** 楽譜を「いつ・どの高さを・どれだけ鳴らすか」の一覧にする。音は出さないので単体テストできる。 */
import { PPQ } from '../model/duration';
import { toMidi } from '../model/pitch';
import { Instrument, Score, capacityAt, eventTicks, playOrder, tempoAt } from '../model/score';

export interface ScheduledNote {
  /** 再生開始からの秒 */
  time: number;
  duration: number;
  midi: number;
  instrument: Instrument;
  partIndex: number;
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
  order.forEach((mi, k) => {
    starts[k] = t;
    spts[k] = secondsPerTick(tempoAt(score, mi));
    t += capacityAt(score, mi) * spts[k];
  });
  const length = t;
  const timeAt = (k: number, tick: number) => starts[k] + tick * spts[k];

  const notes: ScheduledNote[] = [];
  const marks: ScheduledMark[] = [];
  score.parts.forEach((part, partIndex) => {
    // タイで次へ続く音（MIDI番号 → 鳴らしている音）
    let tied = new Map<number, ScheduledNote>();
    order.forEach((mi, k) => {
      let tick = 0;
      part.measures[mi].events.forEach((ev, eventIndex) => {
        const len = eventTicks(ev);
        const start = timeAt(k, tick);
        const end = timeAt(k, tick + len);
        marks.push({ time: start, partIndex, measureIndex: mi, eventIndex });
        const next = new Map<number, ScheduledNote>();
        if (ev.kind === 'note') {
          for (const p of ev.pitches) {
            const midi = toMidi(p);
            let n = tied.get(midi);
            if (n) n.duration = end - n.time;
            else {
              n = { time: start, duration: end - start, midi, instrument: part.instrument, partIndex };
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
