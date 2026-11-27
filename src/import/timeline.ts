/**
 * 「何ティック目から、どれだけの長さ、どの音」の並び（タイムライン）を、この楽譜の小節に詰め直す。
 * MusicXML の取り込みで使う。小節をまたぐ音はタイで分け、すき間は休符で埋める。
 */
import { decompose } from '../model/duration';
import { Pitch } from '../model/pitch';
import { CapacityOf, Measure, MusicEvent, makeNote, makeRest, normalizeMeasure, uid } from '../model/score';

export interface TimedEvent {
  /** 曲の頭からのティック */
  start: number;
  ticks: number;
  /** null なら休符 */
  pitches: Pitch[] | null;
  /** 次の音へタイでつなぐ */
  tie: boolean;
}

/** 32分音符より細かい長さ（連符など）は近い32分音符の位置にそろえる */
export const GRID = 60;
const snap = (t: number) => Math.round(t / GRID) * GRID;

export interface BuildResult {
  measures: Measure[];
  /** 連符などで長さを丸めた */
  quantized: boolean;
  /** 同じ時刻に重なった音（別の声部など）を捨てた */
  droppedOverlap: boolean;
}

/** 小節の長さが小節ごとに違ってもよい、ティック → 小節番号の対応 */
export class Bars {
  private ends: number[] = [];
  constructor(private capacity: CapacityOf) {}
  cap(i: number) {
    return typeof this.capacity === 'number' ? this.capacity : this.capacity(i);
  }
  /** i 小節目の終わりのティック */
  end(i: number) {
    while (this.ends.length <= i) this.ends.push((this.ends[this.ends.length - 1] ?? 0) + this.cap(this.ends.length));
    return this.ends[i];
  }
  start(i: number) {
    return i === 0 ? 0 : this.end(i - 1);
  }
  /** tick を含む小節の番号 */
  indexAt(tick: number) {
    let i = 0;
    while (this.end(i) <= tick) i++;
    return i;
  }
}

export function buildMeasures(events: TimedEvent[], capacity: CapacityOf, minMeasures = 1): BuildResult {
  const bars = new Bars(capacity);
  let quantized = false;
  let droppedOverlap = false;
  const sorted = events
    .map((e) => {
      const start = snap(e.start);
      const end = snap(e.start + e.ticks);
      if (start !== e.start || end !== e.start + e.ticks) quantized = true;
      return { ...e, start, ticks: Math.max(end - start, e.pitches ? GRID : 0) };
    })
    .filter((e) => e.ticks > 0)
    .sort((a, b) => a.start - b.start);

  const buckets: MusicEvent[][] = [];
  let cursor = 0;

  const emit = (len: number, pitches: Pitch[] | null, tieAtEnd: boolean) => {
    while (len > 0) {
      const mi = bars.indexAt(cursor);
      const room = bars.end(mi) - cursor;
      const take = Math.min(room, len);
      const pieces = decompose(take);
      (buckets[mi] ??= []);
      pieces.forEach((pc, k) => {
        const lastOfAll = take === len && k === pieces.length - 1;
        buckets[mi].push(pitches
          ? makeNote(pitches, pc.duration, pc.dots, lastOfAll ? tieAtEnd : true)
          : makeRest(pc.duration, pc.dots));
      });
      cursor += take;
      len -= take;
    }
  };

  for (const e of sorted) {
    let { start, ticks } = e;
    if (start < cursor) {
      // 前の音と重なっている：重なった分は捨てる
      droppedOverlap = true;
      const end = start + ticks;
      if (end <= cursor) continue;
      ticks = end - cursor;
      start = cursor;
    }
    if (start > cursor) emit(start - cursor, null, false);
    emit(ticks, e.pitches, e.pitches ? e.tie : false);
  }

  const count = Math.max(minMeasures, cursor > 0 ? bars.indexAt(cursor - 1) + 1 : 1, 1);
  if (cursor < bars.end(count - 1)) emit(bars.end(count - 1) - cursor, null, false);

  const measures: Measure[] = [];
  for (let i = 0; i < count; i++) {
    const m: Measure = { id: uid(), events: buckets[i] ?? [] };
    normalizeMeasure(m, bars.cap(i));
    measures.push(m);
  }
  return { measures, quantized, droppedOverlap };
}
