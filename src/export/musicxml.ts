/** Score → MusicXML（score-partwise 3.1）。MuseScore などほかの楽譜ソフトへ持っていくため。 */
import { DurationType, PPQ } from '../model/duration';
import { Pitch } from '../model/pitch';
import {
  Clef, Score, eventTicks, keyAt, keyChangeAt, measureAttrsAt, tempoMarkAt, timeSigAt, timeSigChangeAt,
} from '../model/score';

const TYPE_NAMES: Record<DurationType, string> = {
  w: 'whole', h: 'half', q: 'quarter', '8': 'eighth', '16': '16th', '32': '32nd',
};
const CLEFS: Record<Clef, [string, number]> = { treble: ['G', 2], bass: ['F', 4], alto: ['C', 3] };

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

function pitchXml(p: Pitch): string {
  return `<pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ''}<octave>${p.octave}</octave></pitch>`;
}

export function toMusicXml(score: Score): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  out.push('<score-partwise version="3.1">');
  out.push(`<work><work-title>${esc(score.title)}</work-title></work>`);
  out.push('<identification>');
  if (score.composer) out.push(`<creator type="composer">${esc(score.composer)}</creator>`);
  out.push('<encoding><software>mobile-score-editor</software></encoding></identification>');
  out.push('<part-list>');
  score.parts.forEach((p, i) => out.push(`<score-part id="P${i + 1}"><part-name>${esc(p.name)}</part-name></score-part>`));
  out.push('</part-list>');

  score.parts.forEach((part, pi) => {
    out.push(`<part id="P${pi + 1}">`);
    let tiedFromPrev = new Set<string>();
    part.measures.forEach((m, mi) => {
      // 弱起の小節は 0 番で、足りない長さの小節（implicit）として書く
      const pickup = !!score.pickup && mi === 0;
      out.push(`<measure number="${mi + (score.pickup ? 0 : 1)}"${pickup ? ' implicit="yes"' : ''}>`);
      const attrs = measureAttrsAt(score, mi);
      const ending = (type: string) => `<ending number="${attrs!.volta!.join(', ')}" type="${type}"/>`;
      const voltaKey = attrs?.volta?.join(',');
      const voltaBegins = !!voltaKey && measureAttrsAt(score, mi - 1)?.volta?.join(',') !== voltaKey;
      const voltaEnds = !!voltaKey && (mi === part.measures.length - 1 || measureAttrsAt(score, mi + 1)?.volta?.join(',') !== voltaKey);
      if (attrs?.repeatStart || voltaBegins) {
        out.push(`<barline location="left">${attrs?.repeatStart ? '<bar-style>heavy-light</bar-style>' : ''}`
          + `${voltaBegins ? ending('start') : ''}${attrs?.repeatStart ? '<repeat direction="forward"/>' : ''}</barline>`);
      }
      const ts = timeSigAt(score, mi);
      const timeXml = `<time><beats>${ts.beats}</beats><beat-type>${ts.beatType}</beat-type></time>`;
      if (mi === 0) {
        const [sign, line] = CLEFS[part.clef];
        out.push(`<attributes><divisions>${PPQ}</divisions><key><fifths>${keyAt(score, 0)}</fifths></key>`
          + timeXml + `<clef><sign>${sign}</sign><line>${line}</line></clef></attributes>`);
      } else {
        const kc = keyChangeAt(score, mi);
        const tc = timeSigChangeAt(score, mi);
        if (kc !== null || tc) {
          out.push(`<attributes>${kc !== null ? `<key><fifths>${kc}</fifths></key>` : ''}${tc ? timeXml : ''}</attributes>`);
        }
      }
      const tempo = tempoMarkAt(score, mi);
      if (tempo !== null && pi === 0) {
        out.push(`<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>`
          + `<per-minute>${tempo}</per-minute></metronome></direction-type><sound tempo="${tempo}"/></direction>`);
      }
      for (const ev of m.events) {
        const dur = eventTicks(ev);
        const dots = '<dot/>'.repeat(ev.dots);
        if (ev.kind === 'rest') {
          out.push(`<note><rest/><duration>${dur}</duration><voice>1</voice><type>${TYPE_NAMES[ev.duration]}</type>${dots}</note>`);
          tiedFromPrev = new Set();
          continue;
        }
        const next = new Set<string>();
        ev.pitches.forEach((p, k) => {
          const key = `${p.step}${p.alter}${p.octave}`;
          const stop = tiedFromPrev.has(key);
          const start = !!ev.tie;
          if (start) next.add(key);
          const ties = (stop ? '<tie type="stop"/>' : '') + (start ? '<tie type="start"/>' : '');
          const tied = (stop ? '<tied type="stop"/>' : '') + (start ? '<tied type="start"/>' : '');
          out.push(`<note>${k > 0 ? '<chord/>' : ''}${pitchXml(p)}<duration>${dur}</duration>${ties}<voice>1</voice>`
            + `<type>${TYPE_NAMES[ev.duration]}</type>${dots}${tied ? `<notations>${tied}</notations>` : ''}</note>`);
        });
        tiedFromPrev = next;
      }
      if (attrs?.repeatEnd || voltaEnds) {
        const times = attrs?.repeatTimes ? ` times="${attrs.repeatTimes}"` : '';
        out.push(`<barline location="right">${attrs?.repeatEnd ? '<bar-style>light-heavy</bar-style>' : ''}`
          + `${voltaEnds ? ending(attrs?.repeatEnd ? 'stop' : 'discontinue') : ''}`
          + `${attrs?.repeatEnd ? `<repeat direction="backward"${times}/>` : ''}</barline>`);
      }
      out.push('</measure>');
    });
    out.push('</part>');
  });
  out.push('</score-partwise>');
  return out.join('\n');
}
