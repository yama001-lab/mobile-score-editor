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
  /** 声部1（符尾は上。声部2がなければふつうの向き） */
  events: MusicEvent[];
  /**
   * 声部2（符尾は下）。省略＝声部2なし。あるときは events と同じく小節をちょうど埋める。
   * 古い保存データにはないので、読むときは voiceEvents() を使う。
   */
  voice2?: MusicEvent[];
  /** 練習番号（A、B…）。いちばん上のパートの小節にだけ付ける */
  rehearsal?: string;
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
  /** この小節のあとで改行する（次の小節から新しい段） */
  systemBreak?: boolean;
  /** この小節のあとで改ページする（PDF。画面では改行として表示） */
  pageBreak?: boolean;
}

/** 曲全体のレイアウト設定 */
export interface ScoreLayout {
  /** 1段に並べる小節の数（省略時は横幅に合わせて自動） */
  measuresPerSystem?: number;
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
  /** スラー・クレッシェンドなど。消えた音符を指すものは無視する（src/model/marks.ts） */
  spanners?: Spanner[];
  /** 1段の小節数など。改行・改ページは小節ごとに measureAttrs で持つ */
  layout?: ScoreLayout;
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

/**
 * 小節内の index の位置から ev（複数可）を上書きで置く。後ろの音は削られ、余りは休符になる。voice=1 なら声部2に置く。
 * 連符にかかったら、その連符はまるごと消す（途中で切れた連符を残さない）。
 */
export function overwriteAt(m: Measure, index: number, ev: MusicEvent | MusicEvent[], beat: number = PPQ, voice = 0): void {
  const evs = Array.isArray(ev) ? ev : [ev];
  const events = voiceEvents(m, voice);
  let t = events.slice(0, index).reduce((s, e) => s + eventTicks(e), 0);
  const end = t + evs.reduce((s, e) => s + eventTicks(e), 0);
  let i = index;
  while (i < events.length && (t < end || (i > 0 && events[i].tuplet && events[i].tuplet!.id === events[i - 1].tuplet?.id))) {
    t += eventTicks(events[i]);
    i++;
  }
  const filler = t > end ? restsBetween(end, t, beat) : [];
  setVoiceEvents(m, voice, [...events.slice(0, index), ...evs, ...filler, ...events.slice(i)]);
}

/**
 * 連符の中の index の位置に、書かれた音価 want の音を上書きで置く（長さは連符の中の書かれた音価で数える）。
 * 連符の残りに収まらないときは、収まる最大の音価にする。置いた音を返す（連符の中でなければ null）。
 */
export function overwriteInTuplet(
  m: Measure, index: number, want: DurationValue, make: (d: DurationValue) => MusicEvent, voice = 0,
): MusicEvent | null {
  const range = tupletRange(voiceEvents(m, voice), index);
  if (!range) return null;
  const [s, e] = range;
  const events = voiceEvents(m, voice);
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
  setVoiceEvents(m, voice, [...events.slice(0, index), ev, ...filler, ...events.slice(i)]);
  return ev;
}

/** 休符だけの小節は1つの休符にまとめる。声部2が休符だけになったら声部2ごと消す。 */
export function normalizeMeasure(m: Measure, capacity: number): void {
  // 声部2が休符だけになったら声部2ごと消す
  if (m.voice2 && m.voice2.every((e) => e.kind === 'rest')) delete m.voice2;
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
export function reflowPart(part: Part, capacity: CapacityOf, beat: number = PPQ): void {
  part.measures = reflowMeasures(part.measures, capacity, beat);
}

/**
 * 小節の並びを、新しい小節の長さ（capacity(i) は流し直したあとの i 番目の長さ）に詰め直す。声部ごとに流す。
 * 曲の途中の拍子変更・弱起の変更でも使う。
 */
export function reflowMeasures(source: Measure[], capacity: CapacityOf, beat: number = PPQ): Measure[] {
  // 練習番号は、元の小節の頭の時刻で新しい小節に付け直す
  const rehearsals: { tick: number; text: string }[] = [];
  let at = 0;
  for (const m of source) {
    if (m.rehearsal) rehearsals.push({ tick: at, text: m.rehearsal });
    at += measureTicks(m);
  }
  const v1 = reflowEvents(source.flatMap((m) => m.events), capacity, beat);
  const hasV2 = source.some((m) => m.voice2);
  const v2 = hasV2 ? reflowEvents(source.flatMap((m) => m.voice2 ?? restsFor(measureTicks(m))), capacity, beat) : [];
  while (v1.length < v2.length) v1.push(restsFor(capOf(capacity, v1.length)));
  const measures: Measure[] = v1.map((events, i) => {
    const m: Measure = { id: uid(), events };
    if (v2[i]) m.voice2 = v2[i];
    return m;
  });
  if (!measures.length) measures.push(createMeasure(capOf(capacity, 0)));
  measures.forEach((m, i) => normalizeMeasure(m, capOf(capacity, i)));
  for (const r of rehearsals) {
    let start = 0;
    let i = 0;
    while (i < measures.length - 1 && start + capOf(capacity, i) <= r.tick) start += capOf(capacity, i++);
    measures[i].rehearsal ??= r.text;
  }
  return measures;
}

/** 音の並びを、小節ごとの並びに分ける（capacity(i) は i 番目の小節の長さ） */
function reflowEvents(all: MusicEvent[], capacity: CapacityOf, beat: number): MusicEvent[][] {
  const measures: MusicEvent[][] = [];
  let cur: MusicEvent[] = [];
  let used = 0;
  const cap = () => capOf(capacity, measures.length);
  const push = (ev: MusicEvent) => {
    cur.push(ev);
    used += eventTicks(ev);
    if (used >= cap()) {
      measures.push(cur);
      cur = [];
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
      if (len > cap()) {
        for (const r of restsFor(len)) push(r);
        continue;
      }
      if (len > cap() - used) for (const r of restsFor(cap() - used)) push(r);
      for (const g of group) push(g);
      continue;
    }
    let remaining = eventTicks(ev);
    let first = true;
    while (remaining > 0) {
      const room = cap() - used;
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
  if (cur.length) {
    cur.push(...restsBetween(used, cap(), beat));
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

/** 曲頭から measure 小節目の頭までのティック（小節ごとに長さが違ってもよい） */
export function measureStartTick(score: Score, measure: number): number {
  let t = 0;
  for (let i = 0; i < measure; i++) t += capacityAt(score, i);
  return t;
}

/** 曲頭からのティック tick を含む小節の番号（最後の小節より後ろなら最後の小節） */
export function measureAtTick(score: Score, tick: number): number {
  const n = score.parts[0].measures.length;
  let t = 0;
  for (let i = 0; i < n; i++) {
    t += capacityAt(score, i);
    if (tick < t) return i;
  }
  return n - 1;
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
