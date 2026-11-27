/**
 * 範囲選択とコピー・貼り付け（MuseScore の範囲選択と同じ考え方）。
 * 範囲は「どのパートからどのパートまで」×「曲頭からのティックでどこからどこまで」で表す。
 * パートごとに音の区切りが違っても、範囲の端で音を分けて（音符はタイでつないで）扱う。
 * 範囲は両方の声部（声部1・声部2）を含む。1音だけを選んだときは、その音の声部だけ（RangeSel.voice）。
 * ここの関数は楽譜データだけを扱い、元に戻すなどは Editor が受け持つ。
 */
import { decompose } from '../model/duration';
import {
  MusicEvent, Part, Score, VOICE_COUNT, beatTicks, capacityAt, eventTicks, findEvent, measureStartTick, normalizeMeasure,
  restsBetween as beatRests, restsFor, setVoiceEvents, timeSigAt, uid, voiceEvents,
} from '../model/score';

export interface RangeSel {
  partFrom: number;
  partTo: number;
  /** 曲頭からのティック（含む） */
  start: number;
  /** 曲頭からのティック（含まない） */
  end: number;
  /** 1つの声部だけの範囲（0=声部1、1=声部2）。省略＝両方の声部 */
  voice?: number;
}

/** コピーした内容。parts[0] が範囲のいちばん上のパート */
export interface Clip {
  ticks: number;
  /** パートごとの声部1の音（voice があるときはその声部の音） */
  parts: MusicEvent[][];
  /** パートごとの声部2の音。範囲に声部2がなかったパートは null */
  voice2?: (MusicEvent[] | null)[];
  /** 1つの声部だけをコピーしたとき、その声部。貼るときは貼る先の声部に入れる */
  voice?: number;
}

/** 範囲が扱う声部 */
function voicesOf(r: { voice?: number }): number[] {
  return r.voice === undefined ? Array.from({ length: VOICE_COUNT }, (_, v) => v) : [r.voice];
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** 小節の位置（弱起・途中の拍子変更で小節ごとに長さが違ってもよい） */
interface Grid {
  /** mi 小節目の頭の、曲頭からのティック */
  start(mi: number): number;
  /** その小節の長さ */
  cap(mi: number): number;
  /** tick を含む小節の番号 */
  at(tick: number): number;
  /** その小節の拍の長さ */
  beat(mi: number): number;
}

function grid(score: Score): Grid {
  const starts: number[] = [0];
  const start = (mi: number) => {
    while (starts.length <= mi) starts.push(starts[starts.length - 1] + capacityAt(score, starts.length - 1));
    return starts[mi];
  };
  return {
    start,
    cap: (mi) => capacityAt(score, mi),
    at: (tick) => {
      let mi = 0;
      while (start(mi + 1) <= tick) mi++;
      return mi;
    },
    beat: (mi) => beatTicks(timeSigAt(score, mi)),
  };
}

/** 音符・休符の、曲頭からの位置と声部 */
export function eventSpan(score: Score, id: string): { partIndex: number; start: number; end: number; voice: number } | null {
  const loc = findEvent(score, id);
  if (!loc) return null;
  const events = voiceEvents(score.parts[loc.partIndex].measures[loc.measureIndex], loc.voice);
  let t = measureStartTick(score, loc.measureIndex);
  for (let i = 0; i < loc.eventIndex; i++) t += eventTicks(events[i]);
  return { partIndex: loc.partIndex, start: t, end: t + eventTicks(events[loc.eventIndex]), voice: loc.voice ?? 0 };
}

/** 2つの音符・休符を両端とする範囲 */
export function rangeBetween(score: Score, aId: string, bId: string): RangeSel | null {
  const a = eventSpan(score, aId);
  const b = eventSpan(score, bId);
  if (!a || !b) return null;
  return {
    partFrom: Math.min(a.partIndex, b.partIndex),
    partTo: Math.max(a.partIndex, b.partIndex),
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
  };
}

/** パートの声部の音を、曲頭からの位置つきで並べる（声部2のない小節はとばす） */
function placed(part: Part, g: Grid, voice = 0): { ev: MusicEvent; start: number; mi: number; ei: number }[] {
  const out: { ev: MusicEvent; start: number; mi: number; ei: number }[] = [];
  part.measures.forEach((m, mi) => {
    let t = g.start(mi);
    voiceEvents(m, voice).forEach((ev, ei) => {
      out.push({ ev, start: t, mi, ei });
      t += eventTicks(ev);
    });
  });
  return out;
}

/** 範囲に一部でもかかる音符・休符の id */
export function rangeEventIds(score: Score, r: RangeSel): Set<string> {
  const g = grid(score);
  const ids = new Set<string>();
  for (let p = r.partFrom; p <= r.partTo; p++) {
    const part = score.parts[p];
    if (!part) continue;
    for (const v of voicesOf(r))
      for (const x of placed(part, g, v)) if (x.start < r.end && x.start + eventTicks(x.ev) > r.start) ids.add(x.ev.id);
  }
  return ids;
}

/** 範囲にかかる音符（休符は除く。両方の声部） */
export function rangeNotes(score: Score, r: RangeSel) {
  const ids = rangeEventIds(score, r);
  const out = [];
  for (let p = r.partFrom; p <= r.partTo; p++)
    for (const m of score.parts[p]?.measures ?? []) for (const v of voicesOf(r))
      for (const ev of voiceEvents(m, v)) if (ev.kind === 'note' && ids.has(ev.id)) out.push(ev);
  return out;
}

/**
 * ev を長さ len の音価の並びにする。音符なら途中はタイでつなぎ、最後は tieOut のとおり。
 * keepId なら最初のかけらは元の id を使う。
 */
function cutEvent(ev: MusicEvent, len: number, keepId: boolean, tieOut: boolean): MusicEvent[] {
  if (len === eventTicks(ev)) {
    const c = clone(ev);
    if (!keepId) c.id = uid();
    if (c.kind === 'note') { if (tieOut) c.tie = true; else delete c.tie; }
    return [c];
  }
  const ds = decompose(len);
  return ds.map((d, i) => {
    const c = clone(ev);
    c.id = keepId && i === 0 ? ev.id : uid();
    c.duration = d.duration;
    c.dots = d.dots;
    if (c.kind === 'note') {
      if (i < ds.length - 1 || tieOut) c.tie = true;
      else delete c.tie;
      if (i > 0) delete c.graces;
    }
    return c;
  });
}

/** 分けた音の後ろのかけらには、装飾音を付けない（装飾音は音の頭にだけ付く） */
function dropGraces(evs: MusicEvent[]): MusicEvent[] {
  for (const e of evs) if (e.kind === 'note') delete e.graces;
  return evs;
}

/** 声部の tick の位置で音を2つに分け、そこが音の区切りになるようにする（音符はタイでつなぐ） */
export function splitPartAt(part: Part, tick: number, g: Grid, voice = 0): void {
  const mi = g.at(tick);
  const m = part.measures[mi];
  if (!m) return;
  const events = voiceEvents(m, voice);
  let t = g.start(mi);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const len = eventTicks(ev);
    if (t < tick && tick < t + len) {
      const left = cutEvent(ev, tick - t, true, true);
      const right = dropGraces(cutEvent(ev, t + len - tick, false, ev.kind === 'note' && !!ev.tie));
      events.splice(i, 1, ...left, ...right);
      return;
    }
    if (t >= tick) return;
    t += len;
  }
}

/** パートの声部の全小節を見て、次の音と同じ高さがないタイを外す */
function fixTies(part: Part, voice = 0): void {
  const all = part.measures.flatMap((m) => voiceEvents(m, voice));
  all.forEach((ev, i) => {
    if (ev.kind !== 'note' || !ev.tie) return;
    const next = all[i + 1];
    const ok = next?.kind === 'note' && ev.pitches.some((p) => next.pitches.some((q) => q.step === p.step && q.octave === p.octave && q.alter === p.alter));
    if (!ok) delete ev.tie;
  });
}

/** 小節が足りなければ全パートに足す */
export function ensureTicks(score: Score, endTick: number): void {
  const g = grid(score);
  let need = 0;
  while (g.start(need) < endTick) need++;
  for (const p of score.parts) while (p.measures.length < need) p.measures.push({ id: uid(), events: restsFor(g.cap(p.measures.length)) });
}

/**
 * パートの声部の start から、events を上書きで置く。小節線をまたぐ音はタイで分ける。
 * 小節は足りている前提（ensureTicks を先に呼ぶ）。声部2のない小節には休符で声部2を作ってから置く。
 * 置いた音（分けたかけらを含む）を返す。
 */
export function writeEvents(part: Part, start: number, events: MusicEvent[], g: Grid, voice = 0): MusicEvent[] {
  const len = events.reduce((s, e) => s + eventTicks(e), 0);
  if (len <= 0) return [];
  const end = start + len;
  if (voice) for (let mi = g.at(start); mi <= g.at(end - 1); mi++) {
    const m = part.measures[mi];
    if (m && !m.voice2) m.voice2 = restsFor(g.cap(mi));
  }
  splitPartAt(part, start, g, voice);
  splitPartAt(part, end, g, voice);
  const byMeasure = new Map<number, MusicEvent[]>();
  const written: MusicEvent[] = [];
  let t = start;
  for (const ev of events) {
    let remaining = eventTicks(ev);
    let first = true;
    while (remaining > 0) {
      const mi = g.at(t);
      const take = Math.min(g.start(mi) + g.cap(mi) - t, remaining);
      const more = remaining - take > 0;
      const pcs = cutEvent(ev, take, first, more || (ev.kind === 'note' && !!ev.tie));
      if (!byMeasure.has(mi)) byMeasure.set(mi, []);
      byMeasure.get(mi)!.push(...pcs);
      written.push(...pcs);
      t += take;
      remaining -= take;
      first = false;
    }
  }
  for (const [mi, fresh] of byMeasure) {
    const m = part.measures[mi];
    const before: MusicEvent[] = [];
    const after: MusicEvent[] = [];
    let u = g.start(mi);
    for (const ev of voiceEvents(m, voice)) {
      if (u < start) before.push(ev);
      else if (u >= end) after.push(ev);
      u += eventTicks(ev);
    }
    setVoiceEvents(m, voice, [...before, ...fresh, ...after]);
  }
  fixTies(part, voice);
  return written;
}

/** 範囲の小節のどれかに声部2があるか */
function hasVoice2In(part: Part, start: number, end: number, g: Grid): boolean {
  for (let mi = g.at(start); mi <= g.at(end - 1); mi++) if (part.measures[mi]?.voice2) return true;
  return false;
}

/** パートの声部の範囲の音を取り出す（part は書き換えてよい複製） */
function extractVoice(part: Part, r: RangeSel, g: Grid, voice: number): MusicEvent[] {
  if (voice) {
    // 範囲の中で声部2のない小節は、休符として扱う
    for (let mi = g.at(r.start); mi <= g.at(r.end - 1); mi++) {
      const m = part.measures[mi];
      if (m && !m.voice2) m.voice2 = restsFor(g.cap(mi));
    }
  }
  splitPartAt(part, r.start, g, voice);
  splitPartAt(part, r.end, g, voice);
  const evs = placed(part, g, voice).filter((x) => x.start >= r.start && x.start < r.end).map((x) => x.ev);
  // 範囲の外へのタイは持ち出さない
  const last = evs[evs.length - 1];
  if (last?.kind === 'note') delete last.tie;
  return evs;
}

/** 範囲の中身を取り出す（楽譜は変えない）。両方の声部の範囲なら声部2も持ち出す */
export function extractRange(score: Score, r: RangeSel): Clip {
  const g = grid(score);
  const parts: MusicEvent[][] = [];
  const voice2: (MusicEvent[] | null)[] = [];
  for (let p = r.partFrom; p <= r.partTo; p++) {
    const part = clone(score.parts[p]);
    if (r.voice !== undefined) { parts.push(extractVoice(part, r, g, r.voice)); continue; }
    // 声部2が休符だけなら、声部2はないものとして扱う
    const v2 = hasVoice2In(part, r.start, r.end, g) ? extractVoice(part, r, g, 1) : null;
    voice2.push(v2?.some((x) => x.kind === 'note') ? v2 : null);
    parts.push(extractVoice(part, r, g, 0));
  }
  const clip: Clip = { ticks: r.end - r.start, parts };
  if (r.voice !== undefined) clip.voice = r.voice;
  else if (voice2.some((x) => x)) clip.voice2 = voice2;
  return clip;
}

/** 小節線ごとに区切った、拍に沿った休符の並び */
function restsBetween(start: number, end: number, g: Grid): MusicEvent[] {
  const out: MusicEvent[] = [];
  let t = start;
  while (t < end) {
    const mi = g.at(t);
    const ms = g.start(mi);
    const next = Math.min(end, ms + g.cap(mi));
    out.push(...beatRests(t - ms, next - ms, g.beat(mi)));
    t = next;
  }
  return out;
}

/** 範囲を休符にする（両方の声部の範囲なら声部2も）。休符だけになった小節は1つの休符にまとめ、声部2は消える */
export function clearRange(score: Score, r: RangeSel): void {
  const g = grid(score);
  for (let p = r.partFrom; p <= r.partTo; p++) {
    const part = score.parts[p];
    if (!part) continue;
    for (const v of voicesOf(r)) {
      if (v && !hasVoice2In(part, r.start, r.end, g)) continue;
      writeEvents(part, r.start, restsBetween(r.start, r.end, g), g, v);
    }
    const m0 = g.at(r.start);
    const m1 = g.at(r.end - 1);
    for (let mi = m0; mi <= m1; mi++) if (part.measures[mi]) normalizeMeasure(part.measures[mi], g.cap(mi));
  }
}

/**
 * partIndex のパートの start から貼り付ける。複数パートの内容は下のパートへ順に貼る（足りない分は捨てる）。
 * 両方の声部のコピーなら、声部1は声部1へ、声部2は声部2へ貼る（コピーに声部2がなければ、貼る先の声部2は休符になる）。
 * 1つの声部だけのコピー（1音の選択）は、voice の声部へ貼る。貼った範囲を返す。
 */
export function pasteClip(score: Score, clip: Clip, partIndex: number, start: number, voice = 0): RangeSel | null {
  const g = grid(score);
  const n = Math.min(clip.parts.length, score.parts.length - partIndex);
  if (n <= 0 || clip.ticks <= 0) return null;
  ensureTicks(score, start + clip.ticks);
  const end = start + clip.ticks;
  const fresh = (evs: MusicEvent[]) => {
    const out = clone(evs).map((e) => ({ ...e, id: uid() }));
    // 何も入っていないパート（ありえないが念のため）は休符で埋める
    return out.length ? out : restsBetween(start, end, g);
  };
  const single = clip.voice !== undefined;
  for (let k = 0; k < n; k++) {
    const part = score.parts[partIndex + k];
    writeEvents(part, start, fresh(clip.parts[k]), g, single ? voice : 0);
    if (!single) {
      const v2 = clip.voice2?.[k];
      if (v2) writeEvents(part, start, fresh(v2), g, 1);
      else if (hasVoice2In(part, start, end, g)) writeEvents(part, start, restsBetween(start, end, g), g, 1);
    }
    const m0 = g.at(start);
    const m1 = g.at(end - 1);
    for (let mi = m0; mi <= m1; mi++) normalizeMeasure(part.measures[mi], g.cap(mi));
  }
  const r: RangeSel = { partFrom: partIndex, partTo: partIndex + n - 1, start, end };
  if (single) r.voice = voice;
  return r;
}

/** 範囲の両端にあたる音符・休符の id（選択の印に使う。両方の声部の範囲なら声部1の音） */
export function rangeEnds(score: Score, r: RangeSel): { first: string; last: string } | null {
  const g = grid(score);
  const v = r.voice ?? 0;
  const top = placed(score.parts[r.partFrom], g, v).find((x) => x.start + eventTicks(x.ev) > r.start);
  const bottomList = placed(score.parts[r.partTo], g, v).filter((x) => x.start < r.end);
  const bottom = bottomList[bottomList.length - 1];
  if (!top || !bottom) return null;
  return { first: top.ev.id, last: bottom.ev.id };
}
