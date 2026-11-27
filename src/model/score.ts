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

export interface NoteEvent extends EventMarks {
  id: string;
  kind: 'note';
  duration: DurationType;
  dots: number;
  /** 和音なら複数。低い順に並べる。 */
  pitches: Pitch[];
  /** 次の音符へタイでつなぐ */
  tie?: boolean;
}

export interface RestEvent extends EventMarks {
  id: string;
  kind: 'rest';
  duration: DurationType;
  dots: number;
}

/** アーティキュレーション（スタッカートなど）。休符に付けられるのはフェルマータだけ */
export type Articulation = 'staccato' | 'accent' | 'tenuto' | 'marcato' | 'fermata';
/** 強弱記号 */
export type Dynamic = 'pp' | 'p' | 'mp' | 'mf' | 'f' | 'ff' | 'sfz' | 'fp';

/** 音符・休符1つに付く記号（src/model/marks.ts で編集する） */
export interface EventMarks {
  articulations?: Articulation[];
  dynamic?: Dynamic;
}

/** 複数の音符にまたがる記号：スラー、クレッシェンド（cresc）、ディミヌエンド（dim） */
export type SpannerKind = 'slur' | 'cresc' | 'dim';

export interface Spanner {
  id: string;
  kind: SpannerKind;
  /** 始まりと終わりの音符（休符）の id。同じパートの中で from が先 */
  from: string;
  to: string;
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
  /** スラー・クレッシェンドなど。消えた音符を指すものは無視する（src/model/marks.ts） */
  spanners?: Spanner[];
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
export function reflowPart(part: Part, capacity: number): void {
  const all = part.measures.flatMap((m) => m.events);
  const measures: Measure[] = [];
  let cur: Measure = { id: uid(), events: [] };
  let used = 0;
  const push = (ev: MusicEvent) => {
    cur.events.push(ev);
    used += eventTicks(ev);
    if (used >= capacity) {
      measures.push(cur);
      cur = { id: uid(), events: [] };
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
        const piece = ev.kind === 'note'
          ? makeNote(ev.pitches, pc.duration, pc.dots, isLast ? !!ev.tie : true)
          : makeRest(pc.duration, pc.dots);
        // 最初のかけらは元の id と記号を引き継ぐ（スラーなどが付いたままになるように）
        if (first && k === 0) {
          piece.id = ev.id;
          if (ev.articulations) piece.articulations = [...ev.articulations];
          if (ev.dynamic) piece.dynamic = ev.dynamic;
        }
        push(piece);
      }
      remaining -= take;
      first = false;
    }
  }
  if (cur.events.length) {
    cur.events.push(...restsFor(capacity - used));
    measures.push(cur);
  }
  if (!measures.length) measures.push(createMeasure(capacity));
  measures.forEach((m) => normalizeMeasure(m, capacity));
  part.measures = measures;
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
