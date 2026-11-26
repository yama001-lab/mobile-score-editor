/** 楽譜を「いつ・どの高さを・どれだけ鳴らすか」の一覧にする。音は出さないので単体テストできる。 */
import { PPQ } from '../model/duration';
import { toMidi } from '../model/pitch';
import { Instrument, Score, eventTicks } from '../model/score';

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

export function secondsPerTick(score: Score) {
  return 60 / (score.tempo * PPQ);
}

/** fromMeasure 小節目（0始まり）から最後まで。タイでつながった同じ高さの音は1つの長い音にする。 */
export function buildSchedule(score: Score, fromMeasure = 0): Schedule {
  const spt = secondsPerTick(score);
  const notes: ScheduledNote[] = [];
  const marks: ScheduledMark[] = [];
  let lengthTicks = 0;
  score.parts.forEach((part, partIndex) => {
    let tick = 0;
    // タイで次へ続く音（MIDI番号 → 鳴らしている音）
    let tied = new Map<number, ScheduledNote>();
    for (let mi = fromMeasure; mi < part.measures.length; mi++) {
      part.measures[mi].events.forEach((ev, eventIndex) => {
        const len = eventTicks(ev);
        marks.push({ time: tick * spt, partIndex, measureIndex: mi, eventIndex });
        const next = new Map<number, ScheduledNote>();
        if (ev.kind === 'note') {
          for (const p of ev.pitches) {
            const midi = toMidi(p);
            let n = tied.get(midi);
            if (n) n.duration += len * spt;
            else {
              n = { time: tick * spt, duration: len * spt, midi, instrument: part.instrument, partIndex };
              notes.push(n);
            }
            if (ev.tie) next.set(midi, n);
          }
        }
        tied = next;
        tick += len;
      });
    }
    lengthTicks = Math.max(lengthTicks, tick);
  });
  notes.sort((a, b) => a.time - b.time);
  marks.sort((a, b) => a.time - b.time || a.partIndex - b.partIndex);
  return { notes, marks, length: lengthTicks * spt };
}
