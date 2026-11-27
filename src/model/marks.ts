/**
 * 記号（アーティキュレーション・強弱・スラー・クレッシェンド/ディミヌエンド）の扱い。
 * 音符1つに付く記号は MusicEvent の articulations / dynamic、
 * 複数の音符にまたがる記号は Score.spanners（始まりと終わりの音符の id）に持つ。
 * 音符が消えてもスパナーは残ることがあるので、使うときは resolveSpanners() で有効なものだけを取り出す。
 */
import {
  Articulation, Dynamic, EventLocation, MusicEvent, Score, Spanner, SpannerKind, VOICE_COUNT, eventTicks, measureStartTick,
  tickOfIndex, uid, voiceEvents,
} from './score';

export const ARTICULATIONS: Articulation[] = ['staccato', 'accent', 'tenuto', 'marcato', 'fermata'];
export const DYNAMICS: Dynamic[] = ['pp', 'p', 'mp', 'mf', 'f', 'ff', 'sfz', 'fp'];

export const ARTICULATION_LABELS: Record<Articulation, string> = {
  staccato: 'スタッカート',
  accent: 'アクセント',
  tenuto: 'テヌート',
  marcato: 'マルカート',
  fermata: 'フェルマータ',
};

export const SPANNER_LABELS: Record<SpannerKind, string> = {
  slur: 'スラー',
  cresc: 'クレッシェンド',
  dim: 'ディミヌエンド',
  '8va': '8va（1オクターブ上で）',
  '8vb': '8vb（1オクターブ下で）',
  pedal: 'ペダル',
};

/** 同時に重ねられない記号の組（スラーどうし、ヘアピンどうし、オクターブ記号どうし、ペダルどうし） */
export function spannerGroup(kind: SpannerKind): string {
  if (kind === 'cresc' || kind === 'dim') return 'hairpin';
  if (kind === '8va' || kind === '8vb') return 'ottava';
  return kind;
}

/** クレッシェンド・ディミヌエンドか */
export const isHairpin = (kind: SpannerKind): kind is 'cresc' | 'dim' => kind === 'cresc' || kind === 'dim';

/** オクターブ記号で鳴らす高さをずらす半音の数 */
export const OTTAVA_SHIFT: Partial<Record<SpannerKind, number>> = { '8va': 12, '8vb': -12 };

/** 休符に付けられるのはフェルマータだけ */
export function canHaveArticulation(ev: MusicEvent, a: Articulation) {
  return ev.kind === 'note' || a === 'fermata';
}

export function toggleArticulationOn(ev: MusicEvent, a: Articulation): void {
  if (!canHaveArticulation(ev, a)) return;
  const list = ev.articulations ?? [];
  let next = list.includes(a) ? list.filter((x) => x !== a) : [...list, a];
  // アクセントとマルカートは片方だけ
  if (!list.includes(a) && a === 'accent') next = next.filter((x) => x !== 'marcato');
  if (!list.includes(a) && a === 'marcato') next = next.filter((x) => x !== 'accent');
  next.sort((x, y) => ARTICULATIONS.indexOf(x) - ARTICULATIONS.indexOf(y));
  if (next.length) ev.articulations = next;
  else delete ev.articulations;
}

export function setDynamicOn(ev: MusicEvent, d: Dynamic | null): void {
  if (d && ev.dynamic !== d) ev.dynamic = d;
  else delete ev.dynamic;
}

/** パートの1つの声部の音符・休符を曲の頭から並べたもの */
export interface FlatEvent {
  ev: MusicEvent;
  loc: EventLocation;
  /** パートの声部の中での通し番号 */
  index: number;
}

/** パートの声部（0=声部1、1=声部2）の音を曲の頭から並べる。声部2のない小節はとばす */
export function flatEvents(score: Score, partIndex: number, voice = 0): FlatEvent[] {
  const out: FlatEvent[] = [];
  score.parts[partIndex]?.measures.forEach((m, measureIndex) =>
    voiceEvents(m, voice).forEach((ev, eventIndex) =>
      out.push({ ev, loc: voice ? { partIndex, measureIndex, eventIndex, voice } : { partIndex, measureIndex, eventIndex }, index: out.length })));
  return out;
}

export interface ResolvedSpanner {
  spanner: Spanner;
  partIndex: number;
  /** 0=声部1、1=声部2 */
  voice: number;
  from: FlatEvent;
  to: FlatEvent;
}

/** 音符の id から、その音符のある声部の並びの中の位置を引けるようにする */
function indexEvents(score: Score): Map<string, { partIndex: number; voice: number; fe: FlatEvent }> {
  const byId = new Map<string, { partIndex: number; voice: number; fe: FlatEvent }>();
  score.parts.forEach((_, pi) => {
    for (let v = 0; v < VOICE_COUNT; v++) flatEvents(score, pi, v).forEach((fe) => byId.set(fe.ev.id, { partIndex: pi, voice: v, fe }));
  });
  return byId;
}

/** 有効なスパナー（両端の音符があり、同じパートの同じ声部で、from が to より前）だけを返す */
export function resolveSpanners(score: Score): ResolvedSpanner[] {
  if (!score.spanners?.length) return [];
  const byId = indexEvents(score);
  const out: ResolvedSpanner[] = [];
  for (const s of score.spanners) {
    const a = byId.get(s.from);
    const b = byId.get(s.to);
    if (!a || !b || a.partIndex !== b.partIndex || a.voice !== b.voice || a.fe.index >= b.fe.index) continue;
    out.push({ spanner: s, partIndex: a.partIndex, voice: a.voice, from: a.fe, to: b.fe });
  }
  return out;
}

/** 無効になったスパナーを消す */
export function pruneSpanners(score: Score): void {
  if (!score.spanners) return;
  const ok = new Set(resolveSpanners(score).map((r) => r.spanner.id));
  score.spanners = score.spanners.filter((s) => ok.has(s.id));
  if (!score.spanners.length) delete score.spanners;
}

/** 同じ種類で、範囲が重なるものを消してから足す（クレッシェンドとディミヌエンドは互いに重ねない） */
export function addSpanner(score: Score, kind: SpannerKind, from: string, to: string): Spanner {
  pruneSpanners(score);
  const s: Spanner = { id: uid(), kind, from, to };
  score.spanners = [...(score.spanners ?? []), s];
  const all = resolveSpanners(score);
  const me = all.find((r) => r.spanner.id === s.id);
  if (me) {
    const clash = (k: SpannerKind) => spannerGroup(k) === spannerGroup(kind);
    const drop = new Set(all
      .filter((r) => r.spanner.id !== s.id && clash(r.spanner.kind) && r.partIndex === me.partIndex && r.voice === me.voice
        && r.from.index <= me.to.index && me.from.index <= r.to.index)
      .map((r) => r.spanner.id));
    score.spanners = score.spanners.filter((x) => !drop.has(x.id));
  }
  return s;
}

export function removeSpanner(score: Score, id: string): void {
  if (!score.spanners) return;
  score.spanners = score.spanners.filter((s) => s.id !== id);
  if (!score.spanners.length) delete score.spanners;
}

/** スラー・オクターブ記号は音符から音符へ。クレッシェンド・ペダルは休符でもよい */
function stepTarget(kind: SpannerKind, fe: FlatEvent) {
  return (kind !== 'slur' && kind !== '8va' && kind !== '8vb') || fe.ev.kind === 'note';
}

/**
 * オクターブ記号のかかった音符の id → 鳴らすときにずらす半音の数。
 * 記号は声部ごとに付くが、同じパートのもう一方の声部の、範囲の中で始まる音にも効かせる（楽譜の読み方と同じ）。
 */
export function ottavaShifts(score: Score): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of resolveSpanners(score)) {
    const shift = OTTAVA_SHIFT[r.spanner.kind];
    if (!shift) continue;
    const seq = flatEvents(score, r.partIndex, r.voice);
    for (let k = r.from.index; k <= r.to.index; k++) out.set(seq[k].ev.id, shift);
    // もう一方の声部：時刻で範囲を求める
    const startAt = absTick(score, r.from), endAt = absTick(score, r.to) + eventTicks(r.to.ev);
    for (let v = 0; v < VOICE_COUNT; v++) {
      if (v === r.voice) continue;
      for (const fe of flatEvents(score, r.partIndex, v)) {
        const t = absTick(score, fe);
        if (t >= startAt && t < endAt && !out.has(fe.ev.id)) out.set(fe.ev.id, shift);
      }
    }
  }
  return out;
}

/** いちばん上のパートで 8va がかかっている小節（テンポ表記などを 8va の線の上へ逃がすため） */
export function ottavaAboveMeasures(score: Score): Set<number> {
  const out = new Set<number>();
  for (const r of resolveSpanners(score)) {
    if (r.partIndex !== 0 || r.spanner.kind !== '8va') continue;
    for (let m = r.from.loc.measureIndex; m <= r.to.loc.measureIndex; m++) out.add(m);
  }
  return out;
}

/** 曲頭からのティック（楽譜に書かれた順。リピートは数えない） */
function absTick(score: Score, fe: FlatEvent): number {
  const m = score.parts[fe.loc.partIndex].measures[fe.loc.measureIndex];
  return measureStartTick(score, fe.loc.measureIndex) + tickOfIndex(voiceEvents(m, fe.loc.voice), fe.loc.eventIndex);
}

/**
 * スラーなどの付け外し。返り値は、続けて押したときに伸ばせるよう次に選ぶ音符の id（なければ null）。
 * - appendMode（入力モードで直前に入れた音符を選んでいる）：直前の音符からこの音符へ。
 *   直前の音符で終わる同じ種類の記号があれば、この音符まで伸ばす
 * - それ以外：選んだ音符から次の音符へ。選んだ音符で終わる記号があれば次の音符まで伸ばし、
 *   選んだ音符から始まる（または途中にある）記号は消す
 */
export function toggleSpannerAt(score: Score, kind: SpannerKind, selectedId: string, appendMode: boolean): string | null {
  pruneSpanners(score);
  const found = indexEvents(score).get(selectedId);
  if (!found) return null;
  const { partIndex, voice } = found;
  // 声部ごとに、その声部の音符の並びの中で前後をたどる
  const seq = flatEvents(score, partIndex, voice);
  const me: FlatEvent = seq[found.fe.index];
  const mine = resolveSpanners(score).filter((r) => r.spanner.kind === kind && r.partIndex === partIndex && r.voice === voice);

  if (appendMode) {
    const prev = [...seq.slice(0, me.index)].reverse().find((fe) => stepTarget(kind, fe));
    const endingHere = mine.find((r) => r.to.ev.id === me!.ev.id);
    if (endingHere) {
      // もう一度押したら外す（1音だけ戻す：伸ばした所までで終える）
      const back = endingHere.from.index < (prev?.index ?? -1) ? prev : undefined;
      if (back) endingHere.spanner.to = back.ev.id;
      else removeSpanner(score, endingHere.spanner.id);
      return me.ev.id;
    }
    if (!prev) return null;
    const endingPrev = mine.find((r) => r.to.ev.id === prev.ev.id);
    if (endingPrev) endingPrev.spanner.to = me.ev.id;
    else addSpanner(score, kind, prev.ev.id, me.ev.id);
    return me.ev.id;
  }

  const next = seq.slice(me.index + 1).find((fe) => stepTarget(kind, fe));
  const endingHere = mine.find((r) => r.to.ev.id === me!.ev.id);
  if (endingHere) {
    if (!next) return me.ev.id;
    removeSpanner(score, endingHere.spanner.id);
    addSpanner(score, kind, endingHere.spanner.from, next.ev.id);
    return next.ev.id;
  }
  const covering = mine.find((r) => r.from.index <= me!.index && me!.index < r.to.index);
  if (covering) {
    removeSpanner(score, covering.spanner.id);
    return me.ev.id;
  }
  if (!next) return null;
  addSpanner(score, kind, me.ev.id, next.ev.id);
  return next.ev.id;
}

/** 選んだ音符にかかっている記号（ボタンの点灯に使う） */
export function spannersAt(score: Score, id: string): SpannerKind[] {
  const out = new Set<SpannerKind>();
  for (const r of resolveSpanners(score)) {
    const idx = [r.from, r.to];
    if (idx.some((fe) => fe.ev.id === id)) out.add(r.spanner.kind);
    else {
      const seq = flatEvents(score, r.partIndex, r.voice);
      const fe = seq.find((x) => x.ev.id === id);
      if (fe && fe.index > r.from.index && fe.index < r.to.index) out.add(r.spanner.kind);
    }
  }
  return [...out];
}
