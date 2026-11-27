/**
 * 「何ティック目から、どれだけの長さ、どの音」の並び（タイムライン）を、この楽譜の小節に詰め直す。
 * MusicXML の取り込みで使う。小節をまたぐ音はタイで分け、すき間は休符で埋める。
 */
import { DurationType, decompose, ticksOf } from '../model/duration';
import { Pitch } from '../model/pitch';
import { CapacityOf, EventMarks, EventTexts, Measure, MusicEvent, copyTexts, makeNote, makeRest, normalizeMeasure, uid } from '../model/score';

/** 連符の一員であること（同じ key の続いた音が1つの連符） */
export interface TimedTuplet {
  key: string;
  actual: number;
  normal: number;
  /** 楽譜に書かれた音価 */
  duration: DurationType;
  dots: number;
}

export interface TimedEvent {
  /** 曲の頭からのティック */
  start: number;
  ticks: number;
  /** null なら休符 */
  pitches: Pitch[] | null;
  /** 次の音へタイでつなぐ */
  tie: boolean;
  /** 歌詞・コードネーム・文字（分けたときは最初の音符に付ける） */
  texts?: EventTexts;
  /** 付いている記号（分けたときは最初のかけらに付ける） */
  marks?: EventMarks;
  /** 置いた結果：最初と最後のかけらの id（スラーなどをつなぐのに使う）。buildMeasures が書き込む */
  placed?: { first: string; last: string };
  tuplet?: TimedTuplet;
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

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** 連符としてそのまま置けるか（長さが整数ティックで、すき間なく続き、1小節に収まる） */
function validTuplet(group: TimedEvent[], bars: Bars): boolean {
  const start = group[0].start;
  if (!near(start, Math.round(start)) || (!near(start % GRID, 0) && !near(start % GRID, GRID))) return false;
  let t = start;
  for (const e of group) {
    const tp = e.tuplet!;
    const want = (ticksOf(tp.duration, tp.dots) * tp.normal) / tp.actual;
    if (!Number.isInteger(want) || !near(e.ticks, want) || !near(e.start, t)) return false;
    t += want;
  }
  const s = Math.round(start);
  const end = Math.round(t);
  return bars.indexAt(s) === bars.indexAt(end - 1);
}

export function buildMeasures(events: TimedEvent[], capacity: CapacityOf, minMeasures = 1): BuildResult {
  const bars = new Bars(capacity);
  let quantized = false;
  let droppedOverlap = false;

  // 連符はまとめて1つの塊にする。置けない連符は、ばらして近い長さに丸める
  const groups: TimedEvent[][] = [];
  const singles: TimedEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const key = events[i].tuplet?.key;
    if (!key) { singles.push(events[i]); continue; }
    let e = i + 1;
    while (e < events.length && events[e].tuplet?.key === key) e++;
    const g = events.slice(i, e);
    if (validTuplet(g, bars)) groups.push(g.map((x) => ({ ...x, start: Math.round(x.start), ticks: Math.round(x.ticks), orig: x })));
    else singles.push(...g.map((x) => ({ ...x, tuplet: undefined })));
    i = e - 1;
  }

  const snapped = singles
    .map((e) => {
      const start = snap(e.start);
      const end = snap(e.start + e.ticks);
      if (start !== e.start || end !== e.start + e.ticks) quantized = true;
      return { ...e, start, ticks: Math.max(end - start, e.pitches ? GRID : 0), orig: e };
    })
    .filter((e) => e.ticks > 0);
  const sorted: (TimedEvent & { orig?: TimedEvent })[][] = [...snapped.map((e) => [e]), ...groups].sort((a, b) => a[0].start - b[0].start);

  const buckets: MusicEvent[][] = [];
  let cursor = 0;

  const emit = (len: number, pitches: Pitch[] | null, tieAtEnd: boolean, src?: TimedEvent) => {
    while (len > 0) {
      const mi = bars.indexAt(cursor);
      const room = bars.end(mi) - cursor;
      const take = Math.min(room, len);
      const pieces = decompose(take);
      (buckets[mi] ??= []);
      pieces.forEach((pc, k) => {
        const lastOfAll = take === len && k === pieces.length - 1;
        const ev: MusicEvent = pitches
          ? makeNote(pitches, pc.duration, pc.dots, lastOfAll ? tieAtEnd : true)
          : makeRest(pc.duration, pc.dots);
        if (src) {
          if (!src.placed) {
            src.placed = { first: ev.id, last: ev.id };
            if (src.marks?.articulations?.length) ev.articulations = [...src.marks.articulations];
            if (src.marks?.dynamic) ev.dynamic = src.marks.dynamic;
            if (src.texts) copyTexts(src.texts, ev);
          }
          src.placed.last = ev.id;
        }
        buckets[mi].push(ev);
      });
      cursor += take;
      len -= take;
    }
  };

  for (const item of sorted) {
    if (item[0].tuplet) {
      const start = item[0].start;
      if (start < cursor) {
        // 前の音と重なっている連符は捨てる
        droppedOverlap = true;
        continue;
      }
      if (start > cursor) emit(start - cursor, null, false);
      const id = uid();
      for (const e of item) {
        const tp = e.tuplet!;
        const ev = e.pitches ? makeNote(e.pitches, tp.duration, tp.dots, e.tie) : makeRest(tp.duration, tp.dots);
        ev.tuplet = { id, actual: tp.actual, normal: tp.normal };
        const src = e.orig ?? e;
        src.placed = { first: ev.id, last: ev.id };
        if (src.marks?.articulations?.length) ev.articulations = [...src.marks.articulations];
        if (src.marks?.dynamic) ev.dynamic = src.marks.dynamic;
        if (src.texts) copyTexts(src.texts, ev);
        (buckets[bars.indexAt(cursor)] ??= []).push(ev);
        cursor += e.ticks;
      }
      continue;
    }
    const e = item[0];
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
    emit(ticks, e.pitches, e.pitches ? e.tie : false, e.orig);
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
