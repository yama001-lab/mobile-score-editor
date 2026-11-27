/** MusicXML 書き出しのうち記号（強弱・ヘアピン・スラー・アーティキュレーション・オクターブ記号・ペダル）の部分 */
import { resolveSpanners } from '../model/marks';
import { Articulation, MusicEvent, Score } from '../model/score';

export const ARTICULATION_XML: Record<Exclude<Articulation, 'fermata'>, string> = {
  staccato: 'staccato', accent: 'accent', tenuto: 'tenuto', marcato: 'strong-accent',
};

export interface MarksXml {
  /** 音符の前に置く <direction>（強弱記号・ヘアピンの始まり） */
  before(ev: MusicEvent): string[];
  /** 音符の後に置く <direction>（ヘアピンの終わり） */
  after(ev: MusicEvent): string[];
  /** <notations> の中身（スラー・アーティキュレーション・フェルマータ） */
  notations(ev: MusicEvent): string;
}

export function marksXml(score: Score): MarksXml {
  const slurStart = new Map<string, number[]>();
  const slurStop = new Map<string, number[]>();
  const wedgeStart = new Map<string, { type: string; num: number }[]>();
  const wedgeStop = new Map<string, number[]>();
  // オクターブ記号・ペダル：音符の前に始まり、音符の後に終わりの <direction>
  const lineStart = new Map<string, string[]>();
  const lineStop = new Map<string, string[]>();
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => m.set(k, [...(m.get(k) ?? []), v]);
  const counters = new Map<string, number>();
  for (const r of resolveSpanners(score)) {
    const kind = r.spanner.kind;
    const ck = `${r.partIndex}:${kind === 'slur' ? 's' : kind === 'cresc' || kind === 'dim' ? 'w' : kind === 'pedal' ? 'p' : 'o'}`;
    const num = ((counters.get(ck) ?? 0) % 6) + 1;
    counters.set(ck, num);
    if (kind === '8va' || kind === '8vb') {
      // MusicXML では、書いた音が鳴る音より下にずれているのが type="down"（= 8va）
      const type = kind === '8va' ? 'down' : 'up';
      const place = kind === '8va' ? 'above' : 'below';
      push(lineStart, r.from.ev.id, `<direction placement="${place}"><direction-type><octave-shift type="${type}" size="8" number="${num}"/></direction-type></direction>`);
      push(lineStop, r.to.ev.id, `<direction placement="${place}"><direction-type><octave-shift type="stop" size="8" number="${num}"/></direction-type></direction>`);
      continue;
    }
    if (kind === 'pedal') {
      push(lineStart, r.from.ev.id, '<direction placement="below"><direction-type><pedal type="start" line="yes"/></direction-type><sound damper-pedal="yes"/></direction>');
      push(lineStop, r.to.ev.id, '<direction placement="below"><direction-type><pedal type="stop" line="yes"/></direction-type><sound damper-pedal="no"/></direction>');
      continue;
    }
    if (kind === 'slur') {
      push(slurStart, r.from.ev.id, num);
      push(slurStop, r.to.ev.id, num);
    } else {
      push(wedgeStart, r.from.ev.id, { type: r.spanner.kind === 'cresc' ? 'crescendo' : 'diminuendo', num });
      push(wedgeStop, r.to.ev.id, num);
    }
  }
  return {
    before(ev) {
      const out: string[] = [];
      if (ev.dynamic) {
        out.push(`<direction placement="below"><direction-type><dynamics><${ev.dynamic}/></dynamics></direction-type></direction>`);
      }
      for (const w of wedgeStart.get(ev.id) ?? []) {
        out.push(`<direction placement="below"><direction-type><wedge type="${w.type}" number="${w.num}"/></direction-type></direction>`);
      }
      out.push(...(lineStart.get(ev.id) ?? []));
      return out;
    },
    after(ev) {
      return [
        ...(wedgeStop.get(ev.id) ?? []).map((n) =>
          `<direction placement="below"><direction-type><wedge type="stop" number="${n}"/></direction-type></direction>`),
        ...(lineStop.get(ev.id) ?? []),
      ];
    },
    notations(ev) {
      let s = '';
      for (const n of slurStop.get(ev.id) ?? []) s += `<slur type="stop" number="${n}"/>`;
      for (const n of slurStart.get(ev.id) ?? []) s += `<slur type="start" number="${n}"/>`;
      const arts = (ev.articulations ?? []).filter((a): a is Exclude<Articulation, 'fermata'> => a !== 'fermata');
      if (arts.length && ev.kind === 'note') s += `<articulations>${arts.map((a) => `<${ARTICULATION_XML[a]}/>`).join('')}</articulations>`;
      if (ev.articulations?.includes('fermata')) s += '<fermata type="upright"/>';
      return s;
    },
  };
}
