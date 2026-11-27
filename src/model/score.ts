/**
 * 楽譜データ。ここが全機能の共通の受け渡し形式。
 * - ステップ2（鍵盤入力・再生）: Editor.inputPitches() で入力、toMidi() と ticks で再生
 * - ステップ3（手書き）: 認識結果を Pitch と DurationValue にして Editor に渡す
 * - ステップ4（PDF取り込み）: OMR結果（MusicXMLなど）を Score に変換する
 * 構造を変えるときは schemaVersion を上げ、storage の migrate() で古いデータを変換する。
 */
import { BASE_TICKS, DurationType, DurationValue, PPQ, decompose, ticksOf } from './duration';
import { Pitch, comparePitch } from './pitch';

export const SCHEMA_VERSION = 1;

export interface TimeSignature {
  beats: number;
  beatType: number;
}

export type Clef = 'treble' | 'bass' | 'alto';
export type Instrument = 'piano' | 'synth';

/**
 * 音符・休符に付ける文字（歌詞・コードネーム・譜表の上の文字）。どれも省略できる。
 * 歌詞は番ごと（lyrics[0] が1番）。末尾が '-' の音節は次の音節とハイフンでつなぐ。
 */
export interface EventTexts {
  lyrics?: string[];
  /** コードネーム（例: "C", "Am7", "F#m7-5", "G/B"） */
  chord?: string;
  /** 譜表の上に書く文字（例: "rit.", "やさしく"） */
  text?: string;
}

/**
 * 連符。actual 個の音を normal 個分の長さで鳴らす（3連符なら 3:2）。
 * 同じ id を持つ、小節内で連続した音符・休符が1つの連符になる。音価（duration）は楽譜に書く形のまま持つ。
 */
export interface Tuplet {
  id: string;
  actual: number;
  normal: number;
}

/** 連符の種類 → normal（何個分の長さか）。ティックが整数で割り切れるものだけ */
export const TUPLET_NORMAL: Record<number, number> = { 2: 3, 3: 2, 4: 3, 5: 4, 6: 4 };

export interface NoteEvent extends EventMarks, EventTexts {
  id: string;
  kind: 'note';
  duration: DurationType;
  dots: number;
  tuplet?: Tuplet;
  /** 和音なら複数。低い順に並べる。 */
  pitches: Pitch[];
  /** 次の音符へタイでつなぐ */
  tie?: boolean;
}

export interface RestEvent extends EventMarks, EventTexts {
  id: string;
  kind: 'rest';
  duration: DurationType;
  dots: number;
  tuplet?: Tuplet;
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
  /** 練習番号（A、B…）。いちばん上のパートの小節にだけ付ける */
  rehearsal?: string;
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

/** 実際に鳴る長さ（連符なら縮めた長さ） */
export function eventTicks(e: MusicEvent): number {
  const t = ticksOf(e.duration, e.dots);
  return e.tuplet ? (t * e.tuplet.normal) / e.tuplet.actual : t;
}

/** 楽譜に書かれた音価の長さ（連符でも縮めない） */
export function writtenTicks(e: MusicEvent): number {
  return ticksOf(e.duration, e.dots);
}

/** events[index] が連符の一部なら、その連符の範囲 [開始, 終わり) */
export function tupletRange(events: MusicEvent[], index: number): [number, number] | null {
  const id = events[index]?.tuplet?.id;
  if (!id) return null;
  let s = index;
  while (s > 0 && events[s - 1].tuplet?.id === id) s--;
  let e = index + 1;
  while (e < events.length && events[e].tuplet?.id === id) e++;
  return [s, e];
}

/** ちょうどその長さになる1つの音価（なければ null） */
export function durationForTicks(ticks: number): DurationValue | null {
  const d = decompose(ticks);
  return d.length === 1 && ticksOf(d[0].duration, d[0].dots) === ticks ? d[0] : null;
}

/**
 * 小節内の index から、span ティック分を actual 連符にした音の並び（頭の1つ目は first、残りは休符）。
 * 作れない長さなら null。
 */
export function makeTupletGroup(span: number, actual: number, first?: MusicEvent): MusicEvent[] | null {
  const normal = TUPLET_NORMAL[actual];
  if (!normal || span % normal) return null;
  const unit = durationForTicks(span / normal);
  if (!unit) return null;
  const tuplet: Tuplet = { id: uid(), actual, normal };
  return Array.from({ length: actual }, (_, i) => {
    if (i === 0 && first?.kind === 'note') {
      const n = makeNote(first.pitches, unit.duration, unit.dots);
      n.tuplet = { ...tuplet };
      return n;
    }
    return makeRest(unit.duration, unit.dots, tuplet);
  });
}

export function measureTicks(m: Measure): number {
  return m.events.reduce((s, e) => s + eventTicks(e), 0);
}

export function makeRest(duration: DurationType, dots = 0, tuplet?: Tuplet): RestEvent {
  const r: RestEvent = { id: uid(), kind: 'rest', duration, dots };
  if (tuplet) r.tuplet = { ...tuplet };
  return r;
}

export function makeNote(pitches: Pitch[], duration: DurationType, dots = 0, tie = false): NoteEvent {
  const n: NoteEvent = { id: uid(), kind: 'note', duration, dots, pitches: [...pitches].sort(comparePitch) };
  if (tie) n.tie = true;
  return n;
}

export function restsFor(ticks: number) {
  return decompose(ticks).map((d) => makeRest(d.duration, d.dots));
}

/** 拍の長さ（ティック）。6/8・9/8・12/8 などの複合拍子は付点4分を1拍とする。 */
export function beatTicks(ts: TimeSignature): number {
  const unit = (4 * PPQ) / ts.beatType;
  return ts.beatType >= 8 && ts.beats % 3 === 0 && ts.beats > 3 ? unit * 3 : unit;
}

/**
 * 小節の start〜end（小節頭からのティック）を埋める休符。拍の区切りに沿わせる
 * （例: 4/4 の8分目から → 8分・4分・2分。付点2分＋8分にはしない）。
 */
export function restsBetween(start: number, end: number, beat: number = PPQ): RestEvent[] {
  const out: RestEvent[] = [];
  const single = (ticks: number) => {
    const d = decompose(ticks);
    return d.length === 1 && ticksOf(d[0].duration, d[0].dots) === ticks ? d[0] : null;
  };
  let t = start;
  while (t < end) {
    let take = 0;
    if (t % beat === 0 && end - t >= beat) {
      // 拍の頭：その位置で割り切れる、拍の2のべき乗倍のうち一番長いもの
      take = beat;
      while (t % (take * 2) === 0 && t + take * 2 <= end && single(take * 2)) take *= 2;
      if (!single(take)) take = 0;
    }
    if (!take) {
      // 拍の途中：次の拍の頭までを、位置で割り切れる2のべき乗の長さで埋める
      const limit = Math.min(end, (Math.floor(t / beat) + 1) * beat);
      for (let d = BASE_TICKS.w; d >= BASE_TICKS['32']; d /= 2) {
        if (t % d === 0 && t + d <= limit) { take = d; break; }
      }
    }
    if (!take) {
      out.push(...restsFor(end - t));
      break;
    }
    const v = single(take)!;
    out.push(makeRest(v.duration, v.dots));
    t += take;
  }
  return out;
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

/**
 * 小節内の index の位置から ev（複数可）を上書きで置く。後ろの音は削られ、余りは休符になる。
 * 連符にかかったら、その連符はまるごと消す（途中で切れた連符を残さない）。
 */
export function overwriteAt(m: Measure, index: number, ev: MusicEvent | MusicEvent[], beat: number = PPQ): void {
  const evs = Array.isArray(ev) ? ev : [ev];
  const events = m.events;
  let t = events.slice(0, index).reduce((s, e) => s + eventTicks(e), 0);
  const end = t + evs.reduce((s, e) => s + eventTicks(e), 0);
  let i = index;
  while (i < events.length && (t < end || (i > 0 && events[i].tuplet && events[i].tuplet!.id === events[i - 1].tuplet?.id))) {
    t += eventTicks(events[i]);
    i++;
  }
  const filler = t > end ? restsBetween(end, t, beat) : [];
  m.events = [...events.slice(0, index), ...evs, ...filler, ...events.slice(i)];
}

/**
 * 連符の中の index の位置に、書かれた音価 want の音を上書きで置く（長さは連符の中の書かれた音価で数える）。
 * 連符の残りに収まらないときは、収まる最大の音価にする。置いた音を返す（連符の中でなければ null）。
 */
export function overwriteInTuplet(m: Measure, index: number, want: DurationValue, make: (d: DurationValue) => MusicEvent): MusicEvent | null {
  const range = tupletRange(m.events, index);
  if (!range) return null;
  const [s, e] = range;
  const events = m.events;
  const tuplet = events[index].tuplet!;
  const sum = (a: number, b: number) => events.slice(a, b).reduce((x, ev) => x + writtenTicks(ev), 0);
  const local = sum(s, index);
  const room = sum(s, e) - local;
  let d = want;
  if (ticksOf(d.duration, d.dots) > room) {
    const fit = decompose(room)[0];
    if (!fit) return null;
    d = fit;
  }
  const ev = make(d);
  ev.tuplet = { ...tuplet };
  const end = local + ticksOf(d.duration, d.dots);
  let t = local;
  let i = index;
  while (i < e && t < end) {
    t += writtenTicks(events[i]);
    i++;
  }
  const filler = t > end ? decompose(t - end).map((x) => makeRest(x.duration, x.dots, tuplet)) : [];
  m.events = [...events.slice(0, index), ev, ...filler, ...events.slice(i)];
  return ev;
}

/** 休符だけの小節は1つの休符にまとめる。 */
export function normalizeMeasure(m: Measure, capacity: number): void {
  // 連符の枠（休符だけの連符）は、これから音を入れるために残す
  if (m.events.every((e) => e.kind === 'rest' && !e.tuplet)) {
    // 2つ目以降の休符にコードネームなどが付いているときは、まとめると消えてしまうのでそのまま
    if (m.events.slice(1).some(hasTexts)) return;
    const first = m.events[0];
    const total = Math.max(measureTicks(m), capacity);
    m.events = restsFor(total);
    if (first && m.events[0]) copyTexts(first, m.events[0], false);
  }
}

/** 歌詞・コードネーム・文字のどれかが付いているか */
export function hasTexts(e: EventTexts): boolean {
  return !!(e.lyrics?.some((l) => l) || e.chord || e.text);
}

/** from の文字を to へ写す。休符には歌詞を付けない */
export function copyTexts(from: EventTexts, to: MusicEvent, lyrics = true): void {
  if (lyrics && to.kind === 'note' && from.lyrics?.some((l) => l)) to.lyrics = [...from.lyrics];
  if (from.chord) to.chord = from.chord;
  if (from.text) to.text = from.text;
}

/** 拍子が変わったとき、パートの音を新しい小節の長さに流し直す。小節をまたぐ音はタイで分ける。 */
export function reflowPart(part: Part, capacity: number, beat: number = PPQ): void {
  const all = part.measures.flatMap((m) => m.events);
  // 練習番号は、元の小節の頭の時刻で新しい小節に付け直す
  const rehearsals: { tick: number; text: string }[] = [];
  let at = 0;
  for (const m of part.measures) {
    if (m.rehearsal) rehearsals.push({ tick: at, text: m.rehearsal });
    at += measureTicks(m);
  }
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
  for (let k = 0; k < all.length; k++) {
    const ev = all[k];
    if (ev.tuplet) {
      // 連符はまとめて動かす。小節線をまたぐなら次の小節の頭へ送る。小節より長ければ休符にする
      let e = k + 1;
      while (e < all.length && all[e].tuplet?.id === ev.tuplet.id) e++;
      const group = all.slice(k, e);
      const len = group.reduce((s, g) => s + eventTicks(g), 0);
      k = e - 1;
      if (len > capacity) {
        for (const r of restsFor(len)) push(r);
        continue;
      }
      if (len > capacity - used) for (const r of restsFor(capacity - used)) push(r);
      for (const g of group) push(g);
      continue;
    }
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
          copyTexts(ev, piece);
        }
        push(piece);
      }
      remaining -= take;
      first = false;
    }
  }
  if (cur.events.length) {
    cur.events.push(...restsBetween(used, capacity, beat));
    measures.push(cur);
  }
  if (!measures.length) measures.push(createMeasure(capacity));
  measures.forEach((m) => normalizeMeasure(m, capacity));
  for (const r of rehearsals) {
    const m = measures[Math.min(measures.length - 1, Math.floor(r.tick / capacity))];
    m.rehearsal ??= r.text;
  }
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
