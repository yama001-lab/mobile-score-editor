/** Score → MusicXML（score-partwise 3.1）。MuseScore などほかの楽譜ソフトへ持っていくため。 */
import { DurationType, PPQ } from '../model/duration';
import { Pitch } from '../model/pitch';
import { Clef, Score, eventTicks, measureTicks, tempoMarkAt } from '../model/score';

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
    // 声部ごとの「前の音からタイが続いている音」
    const tiedFrom: Set<string>[] = [new Set(), new Set()];
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
      const voices = m.voice2 ? [m.events, m.voice2] : [m.events];
      voices.forEach((events, v) => {
        if (v > 0) out.push(`<backup><duration>${measureTicks(m)}</duration></backup>`);
        const voiceNo = v + 1;
        // 声部2がある小節では、声部1の符尾は上、声部2は下
        const stem = voices.length > 1 ? `<stem>${v === 0 ? 'up' : 'down'}</stem>` : '';
        let tiedFromPrev = tiedFrom[v];
        for (const ev of events) {
          const dur = eventTicks(ev);
          const dots = '<dot/>'.repeat(ev.dots);
          if (ev.kind === 'rest') {
            out.push(`<note><rest/><duration>${dur}</duration><voice>${voiceNo}</voice><type>${TYPE_NAMES[ev.duration]}</type>${dots}</note>`);
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
            out.push(`<note>${k > 0 ? '<chord/>' : ''}${pitchXml(p)}<duration>${dur}</duration>${ties}<voice>${voiceNo}</voice>`
              + `<type>${TYPE_NAMES[ev.duration]}</type>${dots}${stem}${tied ? `<notations>${tied}</notations>` : ''}</note>`);
          });
          tiedFromPrev = next;
        }
        tiedFrom[v] = tiedFromPrev;
      });
      if (!m.voice2) tiedFrom[1] = new Set();
      out.push('</measure>');
    });
    out.push('</part>');
  });
  out.push('</score-partwise>');
  return out.join('\n');
}
