/**
 * 楽譜データ。ここが全機能の共通の受け渡し形式。
 * - ステップ2（鍵盤入力・再生）: Editor.inputPitches() で入力、toMidi() と ticks で再生
 * - ステップ3（手書き）: 認識結果を Pitch と DurationValue にして Editor に渡す
 * - ステップ4（PDF取り込み）: OMR結果（MusicXMLなど）を Score に変換する
 * 構造を変えるときは schemaVersion を上げ、storage の migrate() で古いデータを変換する。
 */
import { DurationType, decompose, ticksOf } from './duration';
import { Pitch, comparePitch } from './pitch';

export const SCHEMA_VERSION = 1;

export interface TimeSignature {
  beats: number;
  beatType: number;
}

export type Clef = 'treble' | 'bass' | 'alto';
export type Instrument = 'piano' | 'synth';

export interface NoteEvent {
  id: string;
  kind: 'note';
  duration: DurationType;
  dots: number;
  /** 和音なら複数。低い順に並べる。 */
  pitches: Pitch[];
  /** 次の音符へタイでつなぐ */
  tie?: boolean;
}

export interface RestEvent {
  id: string;
  kind: 'rest';
  duration: DurationType;
  dots: number;
}

export type MusicEvent = NoteEvent | RestEvent;

export interface Measure {
  id: string;
  events: MusicEvent[];
}

export interface Part {
  id: string;
  name: string;
  clef: Clef;
  instrument: Instrument;
  measures: Measure[];
}

export interface TempoMark {
  /** 小節番号（0始まり、1以上） */
  measure: number;
  /** 4分音符 = tempo/分 */
  tempo: number;
}

/**
 * 小節ごとの記号（全パート共通）。measure は小節番号（0始まり）。
 * 小節を足したり消したりしたら shiftMeasureMarks() で番号をずらす。
 */
export interface MeasureAttrs {
  measure: number;
  /** この小節から拍子を変える */
  timeSignature?: TimeSignature;
  /** この小節から調号を変える（シャープの数、フラットは負） */
  keyFifths?: number;
  /** 小節の頭にリピート開始 |: */
  repeatStart?: boolean;
  /** 小節の終わりにリピート終了 :| */
  repeatEnd?: boolean;
  /** :| で戻る回数を含めた演奏回数（省略時 2。カッコ付きならカッコの番号から決める） */
  repeatTimes?: number;
  /** 番号付きカッコ（1番・2番）。この小節が何番のときに弾かれるか。続く小節で同じ番号なら1つのカッコ */
  volta?: number[];
}

export interface Score {
  schemaVersion: number;
  id: string;
  title: string;
  composer: string;
  /** 4分音符 = tempo/分 */
  tempo: number;
  timeSignature: TimeSignature;
  /** 調号: シャープの数（フラットは負の数） */
  keyFifths: number;
  /** 全パートの小節数は常に同じ */
  parts: Part[];
  /** 途中のテンポ変更（その小節の頭から）。1小節目のテンポは tempo。小節番号の昇順 */
  tempoMarks?: TempoMark[];
  /** 小節ごとの拍子・調号の変更、リピート、番号付きカッコ。小節番号の昇順 */
  measureAttrs?: MeasureAttrs[];
  /** 弱起（アウフタクト）：1小節目の長さ（ティック）。省略時は普通の1小節 */
  pickup?: number;
  /** 再生のチューニング：A4（ラ）の周波数 Hz。省略時は 440 */
  tuning?: number;
  createdAt: number;
  updatedAt: number;
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function measureCapacity(ts: TimeSignature): number {
  return (ts.beats * 4 * 480) / ts.beatType;
}

export function eventTicks(e: MusicEvent): number {
  return ticksOf(e.duration, e.dots);
}

export function measureTicks(m: Measure): number {
  return m.events.reduce((s, e) => s + eventTicks(e), 0);
}

export function makeRest(duration: DurationType, dots = 0): RestEvent {
  return { id: uid(), kind: 'rest', duration, dots };
}

export function makeNote(pitches: Pitch[], duration: DurationType, dots = 0, tie = false): NoteEvent {
  const n: NoteEvent = { id: uid(), kind: 'note', duration, dots, pitches: [...pitches].sort(comparePitch) };
  if (tie) n.tie = true;
  return n;
}

export function restsFor(ticks: number) {
  return decompose(ticks).map((d) => makeRest(d.duration, d.dots));
}

export function createMeasure(capacity: number): Measure {
  return { id: uid(), events: restsFor(capacity) };
}

export type CapacityOf = number | ((measureIndex: number) => number);
const capOf = (c: CapacityOf, i: number) => (typeof c === 'number' ? c : c(i));

export function createPart(name: string, clef: Clef, measureCount: number, capacity: CapacityOf): Part {
  return {
    id: uid(),
    name,
    clef,
    instrument: 'piano',
    measures: Array.from({ length: measureCount }, (_, i) => createMeasure(capOf(capacity, i))),
  };
}

export function createScore(opts: Partial<Pick<Score, 'title' | 'composer' | 'tempo' | 'keyFifths' | 'timeSignature'>> & { grandStaff?: boolean } = {}): Score {
  const timeSignature = opts.timeSignature ?? { beats: 4, beatType: 4 };
  const cap = measureCapacity(timeSignature);
  const parts = [createPart('右手', 'treble', 8, cap)];
  if (opts.grandStaff) parts.push(createPart('左手', 'bass', 8, cap));
  const now = Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: uid(),
    title: opts.title ?? '無題の楽譜',
    composer: opts.composer ?? '',
    tempo: opts.tempo ?? 100,
    timeSignature,
    keyFifths: opts.keyFifths ?? 0,
    parts,
    createdAt: now,
    updatedAt: now,
  };
}

export interface EventLocation {
  partIndex: number;
  measureIndex: number;
  eventIndex: number;
}

export function findEvent(score: Score, id: string): EventLocation | null {
  for (let p = 0; p < score.parts.length; p++) {
    const ms = score.parts[p].measures;
    for (let m = 0; m < ms.length; m++) {
      const e = ms[m].events.findIndex((ev) => ev.id === id);
      if (e >= 0) return { partIndex: p, measureIndex: m, eventIndex: e };
    }
  }
  return null;
}

export function eventAt(score: Score, loc: EventLocation): MusicEvent | undefined {
  return score.parts[loc.partIndex]?.measures[loc.measureIndex]?.events[loc.eventIndex];
}

/** 小節内の index の位置から ev を上書きで置く。後ろの音は削られ、余りは休符になる。 */
export function overwriteAt(m: Measure, index: number, ev: MusicEvent): void {
  const events = m.events;
  const end = events.slice(0, index).reduce((s, e) => s + eventTicks(e), 0) + eventTicks(ev);
  let t = events.slice(0, index).reduce((s, e) => s + eventTicks(e), 0);
  let i = index;
  while (i < events.length && t < end) {
    t += eventTicks(events[i]);
    i++;
  }
  const filler = t > end ? restsFor(t - end) : [];
  m.events = [...events.slice(0, index), ev, ...filler, ...events.slice(i)];
}

/** 休符だけの小節は1つの休符にまとめる。 */
export function normalizeMeasure(m: Measure, capacity: number): void {
  if (m.events.every((e) => e.kind === 'rest')) {
    const total = Math.max(measureTicks(m), capacity);
    m.events = restsFor(total);
  }
}

/** 拍子が変わったとき、パートの音を新しい小節の長さに流し直す。小節をまたぐ音はタイで分ける。 */
export function reflowPart(part: Part, capacity: CapacityOf): void {
  part.measures = reflowMeasures(part.measures, capacity);
}

/**
 * 小節の並びを、新しい小節の長さ（capacity(i) は流し直したあとの i 番目の長さ）に詰め直す。
 * 曲の途中の拍子変更・弱起の変更でも使う。
 */
export function reflowMeasures(source: Measure[], capacity: CapacityOf): Measure[] {
  const all = source.flatMap((m) => m.events);
  const measures: Measure[] = [];
  let cur: Measure = { id: uid(), events: [] };
  let used = 0;
  const cap = () => capOf(capacity, measures.length);
  const push = (ev: MusicEvent) => {
    cur.events.push(ev);
    used += eventTicks(ev);
    if (used >= cap()) {
      measures.push(cur);
      cur = { id: uid(), events: [] };
      used = 0;
    }
  };
  for (const ev of all) {
    let remaining = eventTicks(ev);
    let first = true;
    while (remaining > 0) {
      const room = cap() - used;
      const take = Math.min(room, remaining);
      const pieces = take === remaining && first ? [{ duration: ev.duration, dots: ev.dots }] : decompose(take);
      for (let k = 0; k < pieces.length; k++) {
        const pc = pieces[k];
        const isLast = remaining - take === 0 && k === pieces.length - 1;
        if (ev.kind === 'note') {
          push(makeNote(ev.pitches, pc.duration, pc.dots, isLast ? !!ev.tie : true));
        } else {
          push(makeRest(pc.duration, pc.dots));
        }
      }
      remaining -= take;
      first = false;
    }
  }
  if (cur.events.length) {
    cur.events.push(...restsFor(cap() - used));
    measures.push(cur);
  }
  if (!measures.length) measures.push(createMeasure(cap()));
  measures.forEach((m, i) => normalizeMeasure(m, capOf(capacity, i)));
  return measures;
}

/** その小節で有効なテンポ */
export function tempoAt(score: Score, measure: number): number {
  let t = score.tempo;
  for (const m of score.tempoMarks ?? []) if (m.measure <= measure) t = m.tempo;
  return t;
}

/** 小節の頭にテンポ表記があるか（1小節目はいつもある） */
export function tempoMarkAt(score: Score, measure: number): number | null {
  if (measure === 0) return score.tempo;
  return score.tempoMarks?.find((m) => m.measure === measure)?.tempo ?? null;
}

/** 全パートの小節数を最長に合わせる。 */
export function equalizeMeasureCounts(score: Score): void {
  const n = Math.max(...score.parts.map((p) => p.measures.length));
  for (const p of score.parts) while (p.measures.length < n) p.measures.push(createMeasure(capacityAt(score, p.measures.length)));
}

// ---------- 小節ごとの拍子・調号・リピート ----------

export function measureAttrsAt(score: Score, measure: number): MeasureAttrs | undefined {
  return score.measureAttrs?.find((a) => a.measure === measure);
}

/** その小節で有効な拍子 */
export function timeSigAt(score: Score, measure: number): TimeSignature {
  let ts = score.timeSignature;
  for (const a of score.measureAttrs ?? []) if (a.measure <= measure && a.timeSignature) ts = a.timeSignature;
  return ts;
}

/** その小節で有効な調号 */
export function keyAt(score: Score, measure: number): number {
  let k = score.keyFifths;
  for (const a of score.measureAttrs ?? []) if (a.measure <= measure && a.keyFifths !== undefined) k = a.keyFifths;
  return k;
}

/** 小節の長さ（ティック）。弱起なら1小節目は短い */
export function capacityAt(score: Score, measure: number): number {
  if (measure === 0 && score.pickup && score.pickup > 0) return Math.min(score.pickup, measureCapacity(timeSigAt(score, 0)));
  return measureCapacity(timeSigAt(score, measure));
}

/** この小節の頭で拍子が変わるか（1小節目は除く） */
export function timeSigChangeAt(score: Score, measure: number): TimeSignature | null {
  if (measure === 0) return null;
  const a = measureAttrsAt(score, measure)?.timeSignature;
  if (!a) return null;
  const prev = timeSigAt(score, measure - 1);
  return a.beats === prev.beats && a.beatType === prev.beatType ? null : a;
}

/** この小節の頭で調号が変わるか（1小節目は除く） */
export function keyChangeAt(score: Score, measure: number): number | null {
  if (measure === 0) return null;
  const a = measureAttrsAt(score, measure)?.keyFifths;
  if (a === undefined || a === keyAt(score, measure - 1)) return null;
  return a;
}

/** 小節の記号を書き換える。空になったら消す */
export function updateMeasureAttrs(score: Score, measure: number, fn: (a: MeasureAttrs) => void): void {
  const list = (score.measureAttrs ??= []);
  let a = list.find((x) => x.measure === measure);
  if (!a) {
    a = { measure };
    list.push(a);
    list.sort((x, y) => x.measure - y.measure);
  }
  fn(a);
  for (const k of Object.keys(a) as (keyof MeasureAttrs)[]) {
    const v = a[k];
    if (v === undefined || v === false || (Array.isArray(v) && !v.length)) delete a[k];
  }
  if (Object.keys(a).length === 1) score.measureAttrs = list.filter((x) => x !== a);
  if (!score.measureAttrs!.length) delete score.measureAttrs;
}

/**
 * 小節を足した・消したときに、小節番号で持っている情報（テンポ変更・小節の記号）をずらす。
 * from 以降の小節を delta だけずらす。delta が負なら from から -delta 個の小節が消えたとして、
 * その中の拍子・調号・テンポの変更は消えずに次の小節へ引き継ぐ（後ろにすでにあればそちらを優先）。
 */
export function shiftMeasureMarks(score: Score, from: number, delta: number): void {
  const n = score.parts[0].measures.length;
  const move = (m: number) => (m >= from ? (delta < 0 ? Math.max(from, m + delta) : m + delta) : m);
  if (score.tempoMarks) {
    const out: TempoMark[] = [];
    for (const t of score.tempoMarks) {
      const removed = delta < 0 && t.measure >= from && t.measure < from - delta;
      const m = move(t.measure);
      if (m < 1 || m >= n) continue;
      const i = out.findIndex((u) => u.measure === m);
      if (i >= 0) { if (!removed) out[i] = { ...t, measure: m }; continue; }
      out.push({ ...t, measure: m });
    }
    score.tempoMarks = out.sort((a, b) => a.measure - b.measure);
  }
  if (score.measureAttrs) {
    const out: MeasureAttrs[] = [];
    for (const a of score.measureAttrs) {
      const removed = delta < 0 && a.measure >= from && a.measure < from - delta;
      const m = move(a.measure);
      if (m >= n) continue;
      // 消えた小節のリピート・カッコは消す。拍子・調号の変更だけ引き継ぐ
      const carried: MeasureAttrs = removed
        ? { measure: m, ...(a.timeSignature ? { timeSignature: a.timeSignature } : {}), ...(a.keyFifths !== undefined ? { keyFifths: a.keyFifths } : {}) }
        : { ...a, measure: m };
      const prev = out.find((u) => u.measure === m);
      if (prev) {
        // 後ろの小節にもともとあった指定を優先する
        if (removed) {
          if (carried.timeSignature && !prev.timeSignature) prev.timeSignature = carried.timeSignature;
          if (carried.keyFifths !== undefined && prev.keyFifths === undefined) prev.keyFifths = carried.keyFifths;
        } else Object.assign(prev, carried);
      } else if (Object.keys(carried).length > 1) out.push(carried);
    }
    // 1小節目の拍子・調号の変更は、曲頭の設定に入れる
    const first = out.find((a) => a.measure === 0);
    if (first?.timeSignature) { score.timeSignature = first.timeSignature; delete first.timeSignature; }
    if (first?.keyFifths !== undefined) { score.keyFifths = first.keyFifths; delete first.keyFifths; }
    score.measureAttrs = out.filter((a) => Object.keys(a).length > 1).sort((a, b) => a.measure - b.measure);
    if (!score.measureAttrs.length) delete score.measureAttrs;
  }
}

/**
 * 演奏する小節の順番（リピートと番号付きカッコをたどる）。
 * - :| で、直前の |: （なければ曲頭か、前の :| の次）へ戻る
 * - 番号付きカッコは、今が何回目かに合う番号のものだけ弾く
 */
export function playOrder(score: Score): number[] {
  const n = score.parts[0].measures.length;
  const order: number[] = [];
  let i = 0;
  let pass = 1;
  let start = 0;
  let jumped = false;
  let inVolta = false;
  const limit = n * 20;
  while (i < n && order.length < limit) {
    const a = measureAttrsAt(score, i);
    if (a?.repeatStart && !jumped) { start = i; pass = 1; }
    jumped = false;
    if (a?.volta?.length) {
      if (!a.volta.includes(pass)) {
        // このカッコをとばす（同じ番号が続く所まで）
        const key = a.volta.join(',');
        while (i < n && measureAttrsAt(score, i)?.volta?.join(',') === key) i++;
        continue;
      }
      inVolta = true;
    } else if (inVolta) {
      // カッコを抜けたら、繰り返しは終わり
      inVolta = false;
      pass = 1;
      start = i;
    }
    order.push(i);
    if (a?.repeatEnd) {
      const times = a.repeatTimes ?? (a.volta?.length ? Math.max(...a.volta) + 1 : 2);
      if (pass < times) {
        pass++;
        i = start;
        jumped = true;
        inVolta = false;
        continue;
      }
      pass = 1;
      start = i + 1;
      inVolta = false;
    }
    i++;
  }
  return order;
}
