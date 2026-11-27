/**
 * 「何ティック目から、どれだけの長さ、どの音」の並び（タイムライン）を、この楽譜の小節に詰め直す。
 * MusicXML の取り込みで使う。小節をまたぐ音はタイで分け、すき間は休符で埋める。
 */
import { decompose } from '../model/duration';
import { Pitch } from '../model/pitch';
import { EventTexts, Measure, MusicEvent, copyTexts, makeNote, makeRest, normalizeMeasure, uid } from '../model/score';

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

export function buildMeasures(events: TimedEvent[], capacity: number, minMeasures = 1): BuildResult {
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

  const emit = (len: number, pitches: Pitch[] | null, tieAtEnd: boolean, texts?: EventTexts) => {
    while (len > 0) {
      const mi = Math.floor(cursor / capacity);
      const room = (mi + 1) * capacity - cursor;
      const take = Math.min(room, len);
      const pieces = decompose(take);
      (buckets[mi] ??= []);
      pieces.forEach((pc, k) => {
        const lastOfAll = take === len && k === pieces.length - 1;
        const ev = pitches
          ? makeNote(pitches, pc.duration, pc.dots, lastOfAll ? tieAtEnd : true)
          : makeRest(pc.duration, pc.dots);
        if (texts) { copyTexts(texts, ev); texts = undefined; }
        buckets[mi].push(ev);
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
    emit(ticks, e.pitches, e.pitches ? e.tie : false, e.texts);
  }

  const count = Math.max(minMeasures, Math.ceil(cursor / capacity), 1);
  if (cursor < count * capacity) emit(count * capacity - cursor, null, false);

  const measures: Measure[] = [];
  for (let i = 0; i < count; i++) {
    const m: Measure = { id: uid(), events: buckets[i] ?? [] };
    normalizeMeasure(m, capacity);
    measures.push(m);
  }
  return { measures, quantized, droppedOverlap };
}
