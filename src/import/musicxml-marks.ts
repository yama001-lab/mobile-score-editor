/** MusicXML 取り込みのうち記号（強弱・ヘアピン・スラー・アーティキュレーション・オクターブ記号・ペダル）の部分 */
import { DYNAMICS } from '../model/marks';
import { Articulation, Dynamic, Spanner, SpannerKind, uid } from '../model/score';
import { TimedEvent } from './timeline';

const ARTICULATION_FROM_XML: Record<string, Articulation> = {
  staccato: 'staccato', staccatissimo: 'staccato', spiccato: 'staccato',
  accent: 'accent', tenuto: 'tenuto', 'detached-legato': 'tenuto', 'strong-accent': 'marcato',
};

interface PendingSpan { kind: SpannerKind; from: TimedEvent; to: TimedEvent }

/** 段（staff）ごとの状態 */
export interface MarkState {
  openSlurs: Map<string, TimedEvent>;
  openWedges: Map<string, { kind: SpannerKind; from: TimedEvent | null }>;
  /** 次の音符に付ける強弱記号 */
  pendingDynamic: Dynamic | null;
  /** 次の音符から始まるヘアピン */
  pendingWedges: { num: string; kind: SpannerKind }[];
  done: PendingSpan[];
}

export function newMarkState(): MarkState {
  return { openSlurs: new Map(), openWedges: new Map(), pendingDynamic: null, pendingWedges: [], done: [] };
}

const kids = (el: Element, name?: string) => Array.from(el.children).filter((c) => !name || c.localName === name);

function addArt(ev: TimedEvent, a: Articulation) {
  const marks = (ev.marks ??= {});
  const list = (marks.articulations ??= []);
  if (!list.includes(a)) list.push(a);
}

/**
 * <note> の記号を読む。chord=true は和音の2音目以降（ev は和音の音符）。
 * スラーの番号は声部ごとに数える（声部1と声部2で同じ番号が使われることがある）
 */
export function readNoteMarks(note: Element, st: MarkState, ev: TimedEvent, chord: boolean, voice = '1'): void {
  if (!chord) {
    if (st.pendingDynamic) {
      (ev.marks ??= {}).dynamic = st.pendingDynamic;
      st.pendingDynamic = null;
    }
    for (const w of st.pendingWedges) st.openWedges.set(w.num, { kind: w.kind, from: ev });
    st.pendingWedges = [];
  }
  for (const n of kids(note, 'notations')) {
    const slurs = kids(n, 'slur');
    for (const sl of slurs) {
      if (sl.getAttribute('type') !== 'stop') continue;
      const num = `${voice}:${sl.getAttribute('number') ?? '1'}`;
      const from = st.openSlurs.get(num);
      if (from && from !== ev) st.done.push({ kind: 'slur', from, to: ev });
      st.openSlurs.delete(num);
    }
    for (const sl of slurs) {
      if (sl.getAttribute('type') !== 'start') continue;
      st.openSlurs.set(`${voice}:${sl.getAttribute('number') ?? '1'}`, ev);
    }
    for (const arts of kids(n, 'articulations')) {
      for (const a of kids(arts)) {
        const m = ARTICULATION_FROM_XML[a.localName];
        if (m && ev.pitches) addArt(ev, m);
      }
    }
    if (kids(n, 'fermata').length) addArt(ev, 'fermata');
    for (const d of kids(n, 'dynamics')) readDynamics(d, st, ev);
  }
}

function readDynamics(d: Element, st: MarkState, ev: TimedEvent | null) {
  const name = kids(d).map((x) => x.localName).find((x) => (DYNAMICS as string[]).includes(x) || x === 'sf' || x === 'sfp');
  if (!name) return;
  const dyn = (name === 'sf' ? 'sfz' : name === 'sfp' ? 'fp' : name) as Dynamic;
  if (ev) (ev.marks ??= {}).dynamic = dyn;
  else st.pendingDynamic = dyn;
}

/** <direction> の強弱記号とヘアピン（wedge）を読む。last は直前に置いた音符 */
export function readDirectionMarks(dir: Element, st: MarkState, last: TimedEvent | null): void {
  for (const dt of kids(dir, 'direction-type')) {
    for (const d of kids(dt, 'dynamics')) readDynamics(d, st, null);
    for (const w of kids(dt, 'wedge')) {
      const type = w.getAttribute('type');
      const num = w.getAttribute('number') ?? '1';
      if (type === 'crescendo' || type === 'diminuendo') {
        st.pendingWedges.push({ num, kind: type === 'crescendo' ? 'cresc' : 'dim' });
      } else if (type === 'stop') closeLine(st, num, last);
    }
    // オクターブ記号：type="down" は書いた音より1オクターブ上で鳴る（8va）、"up" は下（8vb）
    for (const o of kids(dt, 'octave-shift')) {
      const type = o.getAttribute('type');
      const num = 'o' + (o.getAttribute('number') ?? '1');
      const size = parseInt(o.getAttribute('size') ?? '8', 10);
      if ((type === 'down' || type === 'up') && size === 8) st.pendingWedges.push({ num, kind: type === 'down' ? '8va' : '8vb' });
      else if (type === 'stop') closeLine(st, num, last);
    }
    for (const p of kids(dt, 'pedal')) {
      const type = p.getAttribute('type');
      if (type === 'stop' || type === 'change') closeLine(st, 'pedal', last);
      if (type === 'start' || type === 'change') st.pendingWedges.push({ num: 'pedal', kind: 'pedal' });
    }
  }
}

/** 開いているヘアピン・オクターブ記号・ペダルを、直前の音符で閉じる */
function closeLine(st: MarkState, num: string, last: TimedEvent | null) {
  const pending = st.pendingWedges.findIndex((x) => x.num === num);
  if (pending >= 0) { st.pendingWedges.splice(pending, 1); return; }
  const open = st.openWedges.get(num);
  if (open?.from && last && last !== open.from) st.done.push({ kind: open.kind, from: open.from, to: last });
  st.openWedges.delete(num);
}

/** buildMeasures() のあとで、置いた音符の id からスパナーを作る */
export function resolveImportedSpanners(st: MarkState): Spanner[] {
  const out: Spanner[] = [];
  for (const d of st.done) {
    const from = d.from.placed?.first;
    const to = d.to.placed?.last;
    if (from && to && from !== to) out.push({ id: uid(), kind: d.kind, from, to });
  }
  return out;
}
