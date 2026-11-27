/** Score → MusicXML（score-partwise 3.1）。MuseScore などほかの楽譜ソフトへ持っていくため。 */
import { DurationType, PPQ } from '../model/duration';
import { Pitch } from '../model/pitch';
import { Clef, Score, eventTicks, tempoMarkAt } from '../model/score';
import { MarksXml, marksXml } from './musicxml-marks';

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

  const marks: MarksXml = marksXml(score);
  score.parts.forEach((part, pi) => {
    out.push(`<part id="P${pi + 1}">`);
    let tiedFromPrev = new Set<string>();
    part.measures.forEach((m, mi) => {
      out.push(`<measure number="${mi + 1}">`);
      if (mi === 0) {
        const [sign, line] = CLEFS[part.clef];
        out.push(`<attributes><divisions>${PPQ}</divisions><key><fifths>${score.keyFifths}</fifths></key>`
          + `<time><beats>${score.timeSignature.beats}</beats><beat-type>${score.timeSignature.beatType}</beat-type></time>`
          + `<clef><sign>${sign}</sign><line>${line}</line></clef></attributes>`);
      }
      const tempo = tempoMarkAt(score, mi);
      if (tempo !== null && pi === 0) {
        out.push(`<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>`
          + `<per-minute>${tempo}</per-minute></metronome></direction-type><sound tempo="${tempo}"/></direction>`);
      }
      m.events.forEach((ev, ei) => {
        const dur = eventTicks(ev);
        // 連符：<time-modification> と、頭と終わりに <tuplet>
        const t = ev.tuplet;
        const tupStart = !!t && m.events[ei - 1]?.tuplet?.id !== t.id;
        const tupStop = !!t && m.events[ei + 1]?.tuplet?.id !== t.id;
        const dots = '<dot/>'.repeat(ev.dots)
          + (t ? `<time-modification><actual-notes>${t.actual}</actual-notes><normal-notes>${t.normal}</normal-notes></time-modification>` : '');
        const tupXml = (tupStart ? '<tuplet type="start" bracket="yes"/>' : '') + (tupStop ? '<tuplet type="stop"/>' : '');
        out.push(...marks.before(ev));
        if (ev.kind === 'rest') {
          const n = marks.notations(ev) + tupXml;
          out.push(`<note><rest/><duration>${dur}</duration><voice>1</voice><type>${TYPE_NAMES[ev.duration]}</type>${dots}`
            + `${n ? `<notations>${n}</notations>` : ''}</note>`);
          out.push(...marks.after(ev));
          tiedFromPrev = new Set();
          return;
        }
        const next = new Set<string>();
        ev.pitches.forEach((p, k) => {
          const key = `${p.step}${p.alter}${p.octave}`;
          const stop = tiedFromPrev.has(key);
          const start = !!ev.tie;
          if (start) next.add(key);
          const ties = (stop ? '<tie type="stop"/>' : '') + (start ? '<tie type="start"/>' : '');
          const tied = (stop ? '<tied type="stop"/>' : '') + (start ? '<tied type="start"/>' : '')
            + (k === 0 ? marks.notations(ev) + tupXml : '');
          out.push(`<note>${k > 0 ? '<chord/>' : ''}${pitchXml(p)}<duration>${dur}</duration>${ties}<voice>1</voice>`
            + `<type>${TYPE_NAMES[ev.duration]}</type>${dots}${tied ? `<notations>${tied}</notations>` : ''}</note>`);
        });
        out.push(...marks.after(ev));
        tiedFromPrev = next;
      });
      out.push('</measure>');
    });
    out.push('</part>');
  });
  out.push('</score-partwise>');
  return out.join('\n');
}
