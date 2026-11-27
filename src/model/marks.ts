/**
 * 記号（アーティキュレーション・強弱・スラー・クレッシェンド/ディミヌエンド）の扱い。
 * 音符1つに付く記号は MusicEvent の articulations / dynamic、
 * 複数の音符にまたがる記号は Score.spanners（始まりと終わりの音符の id）に持つ。
 * 音符が消えてもスパナーは残ることがあるので、使うときは resolveSpanners() で有効なものだけを取り出す。
 */
import {
  Articulation, Dynamic, EventLocation, MusicEvent, Score, Spanner, SpannerKind, uid,
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
};

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

/** パートの音符・休符を曲の頭から並べたもの */
export interface FlatEvent {
  ev: MusicEvent;
  loc: EventLocation;
  /** パートの中での通し番号 */
  index: number;
}

export function flatEvents(score: Score, partIndex: number): FlatEvent[] {
  const out: FlatEvent[] = [];
  score.parts[partIndex]?.measures.forEach((m, measureIndex) =>
    m.events.forEach((ev, eventIndex) => out.push({ ev, loc: { partIndex, measureIndex, eventIndex }, index: out.length })));
  return out;
}

export interface ResolvedSpanner {
  spanner: Spanner;
  partIndex: number;
  from: FlatEvent;
  to: FlatEvent;
}

/** 有効なスパナー（両端の音符があり、同じパートで、from が to より前）だけを返す */
export function resolveSpanners(score: Score): ResolvedSpanner[] {
  if (!score.spanners?.length) return [];
  const byId = new Map<string, { partIndex: number; fe: FlatEvent }>();
  score.parts.forEach((_, pi) => flatEvents(score, pi).forEach((fe) => byId.set(fe.ev.id, { partIndex: pi, fe })));
  const out: ResolvedSpanner[] = [];
  for (const s of score.spanners) {
    const a = byId.get(s.from);
    const b = byId.get(s.to);
    if (!a || !b || a.partIndex !== b.partIndex || a.fe.index >= b.fe.index) continue;
    out.push({ spanner: s, partIndex: a.partIndex, from: a.fe, to: b.fe });
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
    const clash = (k: SpannerKind) => (kind === 'slur' ? k === 'slur' : k !== 'slur');
    const drop = new Set(all
      .filter((r) => r.spanner.id !== s.id && clash(r.spanner.kind) && r.partIndex === me.partIndex
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

/** スラーは音符から音符へ。クレッシェンドなどは休符でもよい */
function stepTarget(kind: SpannerKind, fe: FlatEvent) {
  return kind !== 'slur' || fe.ev.kind === 'note';
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
  let seq: FlatEvent[] = [];
  let me: FlatEvent | undefined;
  for (let pi = 0; pi < score.parts.length && !me; pi++) {
    seq = flatEvents(score, pi);
    me = seq.find((fe) => fe.ev.id === selectedId);
  }
  if (!me) return null;
  const partIndex = me.loc.partIndex;
  const mine = resolveSpanners(score).filter((r) => r.spanner.kind === kind).filter((r) => r.partIndex === partIndex);

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
      const seq = flatEvents(score, r.partIndex);
      const fe = seq.find((x) => x.ev.id === id);
      if (fe && fe.index > r.from.index && fe.index < r.to.index) out.add(r.spanner.kind);
    }
  }
  return [...out];
}
