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
  /** 声部1（符尾は上。声部2がなければふつうの向き） */
  events: MusicEvent[];
  /**
   * 声部2（符尾は下）。省略＝声部2なし。あるときは events と同じく小節をちょうど埋める。
   * 古い保存データにはないので、読むときは voiceEvents() を使う。
   */
  voice2?: MusicEvent[];
}

/** 1段の中の声部の数（声部1・声部2） */
export const VOICE_COUNT = 2;

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

export function createPart(name: string, clef: Clef, measureCount: number, capacity: number): Part {
  return {
    id: uid(),
    name,
    clef,
    instrument: 'piano',
    measures: Array.from({ length: measureCount }, () => createMeasure(capacity)),
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
  /** 0=声部1（省略時）、1=声部2 */
  voice?: number;
}

/** 声部の音の並び。声部2がない小節では空の配列（読むだけ用） */
export function voiceEvents(m: Measure, voice = 0): MusicEvent[] {
  return voice ? (m.voice2 ?? []) : m.events;
}

/** 声部の音の並び。声部2がなければ休符で埋めて作る（書き換える前に使う） */
export function ensureVoice(m: Measure, voice: number, capacity: number): MusicEvent[] {
  if (!voice) return m.events;
  return (m.voice2 ??= restsFor(capacity));
}

export function setVoiceEvents(m: Measure, voice: number, events: MusicEvent[]): void {
  if (voice) m.voice2 = events;
  else m.events = events;
}

/** 小節の全声部の音（声部1、声部2の順） */
export function measureEvents(m: Measure): MusicEvent[] {
  return m.voice2 ? [...m.events, ...m.voice2] : m.events;
}

/** 声部の中で tick の位置から始まる音の番号。休符の途中なら休符を分けてその位置を作る。 */
export function splitRestAt(events: MusicEvent[], tick: number): number {
  let t = 0;
  for (let i = 0; i < events.length; i++) {
    const len = eventTicks(events[i]);
    if (t === tick) return i;
    if (tick < t + len) {
      if (events[i].kind !== 'rest') return i;
      events.splice(i, 1, ...restsFor(tick - t), ...restsFor(t + len - tick));
      return i + restsFor(tick - t).length;
    }
    t += len;
  }
  return Math.max(0, events.length - 1);
}

/** 声部の中の番号 index の音が始まるティック */
export function tickOfIndex(events: MusicEvent[], index: number): number {
  return events.slice(0, index).reduce((s, e) => s + eventTicks(e), 0);
}

export function findEvent(score: Score, id: string): EventLocation | null {
  for (let p = 0; p < score.parts.length; p++) {
    const ms = score.parts[p].measures;
    for (let m = 0; m < ms.length; m++) {
      const e = ms[m].events.findIndex((ev) => ev.id === id);
      if (e >= 0) return { partIndex: p, measureIndex: m, eventIndex: e };
      const e2 = ms[m].voice2?.findIndex((ev) => ev.id === id) ?? -1;
      if (e2 >= 0) return { partIndex: p, measureIndex: m, eventIndex: e2, voice: 1 };
    }
  }
  return null;
}

export function eventAt(score: Score, loc: EventLocation): MusicEvent | undefined {
  const m = score.parts[loc.partIndex]?.measures[loc.measureIndex];
  return m ? voiceEvents(m, loc.voice)[loc.eventIndex] : undefined;
}

/** 小節内の index の位置から ev を上書きで置く。後ろの音は削られ、余りは休符になる。voice=1 なら声部2に置く */
export function overwriteAt(m: Measure, index: number, ev: MusicEvent, voice = 0): void {
  const events = voiceEvents(m, voice);
  const end = events.slice(0, index).reduce((s, e) => s + eventTicks(e), 0) + eventTicks(ev);
  let t = events.slice(0, index).reduce((s, e) => s + eventTicks(e), 0);
  let i = index;
  while (i < events.length && t < end) {
    t += eventTicks(events[i]);
    i++;
  }
  const filler = t > end ? restsFor(t - end) : [];
  setVoiceEvents(m, voice, [...events.slice(0, index), ev, ...filler, ...events.slice(i)]);
}

/** 休符だけの小節は1つの休符にまとめる。声部2が休符だけになったら声部2ごと消す。 */
export function normalizeMeasure(m: Measure, capacity: number): void {
  if (m.events.every((e) => e.kind === 'rest')) {
    const total = Math.max(measureTicks(m), capacity);
    m.events = restsFor(total);
  }
  if (m.voice2 && m.voice2.every((e) => e.kind === 'rest')) delete m.voice2;
}

/** 拍子が変わったとき、パートの音を新しい小節の長さに流し直す。小節をまたぐ音はタイで分ける。声部ごとに流す。 */
export function reflowPart(part: Part, capacity: number): void {
  const oldCap = part.measures.length ? Math.max(...part.measures.map((m) => measureTicks(m))) : capacity;
  const v1 = reflowEvents(part.measures.flatMap((m) => m.events), capacity);
  const hasV2 = part.measures.some((m) => m.voice2);
  const v2 = hasV2
    ? reflowEvents(part.measures.flatMap((m) => m.voice2 ?? restsFor(oldCap)), capacity)
    : [];
  while (v1.length < v2.length) v1.push(restsFor(capacity));
  const measures: Measure[] = v1.map((events, i) => {
    const m: Measure = { id: uid(), events };
    if (v2[i]) m.voice2 = v2[i];
    return m;
  });
  if (!measures.length) measures.push(createMeasure(capacity));
  measures.forEach((m) => normalizeMeasure(m, capacity));
  part.measures = measures;
}

/** 音の並びを、長さ capacity の小節ごとの並びに分ける */
function reflowEvents(all: MusicEvent[], capacity: number): MusicEvent[][] {
  const measures: MusicEvent[][] = [];
  let cur: MusicEvent[] = [];
  let used = 0;
  const push = (ev: MusicEvent) => {
    cur.push(ev);
    used += eventTicks(ev);
    if (used >= capacity) {
      measures.push(cur);
      cur = [];
      used = 0;
    }
  };
  for (const ev of all) {
    let remaining = eventTicks(ev);
    let first = true;
    while (remaining > 0) {
      const room = capacity - used;
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
  if (cur.length) {
    cur.push(...restsFor(capacity - used));
    measures.push(cur);
  }
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
  const cap = measureCapacity(score.timeSignature);
  const n = Math.max(...score.parts.map((p) => p.measures.length));
  for (const p of score.parts) while (p.measures.length < n) p.measures.push(createMeasure(cap));
}
