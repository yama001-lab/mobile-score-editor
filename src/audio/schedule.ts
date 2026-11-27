/** 楽譜を「いつ・どの高さを・どれだけ鳴らすか」の一覧にする。音は出さないので単体テストできる。 */
import { PPQ } from '../model/duration';
import { toMidi } from '../model/pitch';
import { Instrument, Score, VOICE_COUNT, eventTicks, measureCapacity, tempoAt, voiceEvents } from '../model/score';

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
  const length = t;
  const timeAt = (mi: number, tick: number) => starts[mi] + tick * spts[mi];

  const notes: ScheduledNote[] = [];
  const marks: ScheduledMark[] = [];
  score.parts.forEach((part, partIndex) => {
    // 声部ごとに。目印（再生位置）は声部1だけ
    for (let voice = 0; voice < VOICE_COUNT; voice++) {
      if (voice && !part.measures.some((m) => m.voice2)) continue;
      // タイで次へ続く音（MIDI番号 → 鳴らしている音）
      let tied = new Map<number, ScheduledNote>();
      for (let mi = fromMeasure; mi < count; mi++) {
        let tick = 0;
        voiceEvents(part.measures[mi], voice).forEach((ev, eventIndex) => {
          const len = eventTicks(ev);
          const start = timeAt(mi, tick);
          const end = timeAt(mi, tick + len);
          if (!voice) marks.push({ time: start, partIndex, measureIndex: mi, eventIndex });
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
        // 声部2のない小節ではタイは切れる
        if (voice && !part.measures[mi].voice2) tied = new Map();
      }
    }
  });
  notes.sort((a, b) => a.time - b.time);
  marks.sort((a, b) => a.time - b.time || a.partIndex - b.partIndex);
  return { notes, marks, length };
}
