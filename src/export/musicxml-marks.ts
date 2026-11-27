/** MusicXML 書き出しのうち記号（強弱・ヘアピン・スラー・アーティキュレーション）の部分 */
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
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => m.set(k, [...(m.get(k) ?? []), v]);
  const counters = new Map<string, number>();
  for (const r of resolveSpanners(score)) {
    const ck = `${r.partIndex}:${r.spanner.kind === 'slur' ? 's' : 'w'}`;
    const num = ((counters.get(ck) ?? 0) % 6) + 1;
    counters.set(ck, num);
    if (r.spanner.kind === 'slur') {
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
      return out;
    },
    after(ev) {
      return (wedgeStop.get(ev.id) ?? []).map((n) =>
        `<direction placement="below"><direction-type><wedge type="stop" number="${n}"/></direction-type></direction>`);
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
