/** Score → MusicXML（score-partwise 3.1）。MuseScore などほかの楽譜ソフトへ持っていくため。 */
import { DurationType, PPQ } from '../model/duration';
import { Pitch } from '../model/pitch';
import { Clef, MusicEvent, Score, eventTicks, tempoMarkAt } from '../model/score';
import { parseChord, splitSyllable } from '../model/texts';

const TYPE_NAMES: Record<DurationType, string> = {
  w: 'whole', h: 'half', q: 'quarter', '8': 'eighth', '16': '16th', '32': '32nd',
};
const CLEFS: Record<Clef, [string, number]> = { treble: ['G', 2], bass: ['F', 4], alto: ['C', 3] };

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

function pitchXml(p: Pitch): string {
  return `<pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ''}<octave>${p.octave}</octave></pitch>`;
}

/** コードネーム → <harmony>。読めない文字は <words> にする */
function harmonyXml(raw: string): string {
  const c = parseChord(raw);
  if (!c) return `<direction placement="above"><direction-type><words>${esc(raw)}</words></direction-type></direction>`;
  const alter = (a: number) => (a ? `<root-alter>${a}</root-alter>` : '');
  return `<harmony><root><root-step>${c.root.step}</root-step>${alter(c.root.alter)}</root>`
    + `<kind text="${esc(c.suffix)}">${c.kind}</kind>`
    + (c.bass ? `<bass><bass-step>${c.bass.step}</bass-step>${c.bass.alter ? `<bass-alter>${c.bass.alter}</bass-alter>` : ''}</bass>` : '')
    + '</harmony>';
}

/** 音符・休符の前に置く、コードネームと譜表の上の文字 */
function textsBefore(ev: MusicEvent): string {
  let x = '';
  if (ev.text) x += `<direction placement="above"><direction-type><words>${esc(ev.text)}</words></direction-type></direction>`;
  if (ev.chord) x += harmonyXml(ev.chord);
  return x;
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
    /** 番ごとの、前の音節がハイフンでつながっているか */
    const hyphenOpen: boolean[] = [];
    const lyricsXml = (ev: MusicEvent): string => {
      if (ev.kind !== 'note' || !ev.lyrics) return '';
      return ev.lyrics.map((raw, v) => {
        if (!raw) return '';
        const { text, hyphen } = splitSyllable(raw);
        const open = !!hyphenOpen[v];
        hyphenOpen[v] = hyphen;
        const syl = open ? (hyphen ? 'middle' : 'end') : hyphen ? 'begin' : 'single';
        return `<lyric number="${v + 1}"><syllabic>${syl}</syllabic><text>${esc(text)}</text></lyric>`;
      }).join('');
    };
    part.measures.forEach((m, mi) => {
      out.push(`<measure number="${mi + 1}">`);
      if (mi === 0) {
        const [sign, line] = CLEFS[part.clef];
        out.push(`<attributes><divisions>${PPQ}</divisions><key><fifths>${score.keyFifths}</fifths></key>`
          + `<time><beats>${score.timeSignature.beats}</beats><beat-type>${score.timeSignature.beatType}</beat-type></time>`
          + `<clef><sign>${sign}</sign><line>${line}</line></clef></attributes>`);
      }
      if (pi === 0 && m.rehearsal) {
        out.push(`<direction placement="above"><direction-type><rehearsal>${esc(m.rehearsal)}</rehearsal></direction-type></direction>`);
      }
      const tempo = tempoMarkAt(score, mi);
      if (tempo !== null && pi === 0) {
        out.push(`<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>`
          + `<per-minute>${tempo}</per-minute></metronome></direction-type><sound tempo="${tempo}"/></direction>`);
      }
      for (const ev of m.events) {
        const dur = eventTicks(ev);
        const dots = '<dot/>'.repeat(ev.dots);
        const before = textsBefore(ev);
        if (before) out.push(before);
        if (ev.kind === 'rest') {
          out.push(`<note><rest/><duration>${dur}</duration><voice>1</voice><type>${TYPE_NAMES[ev.duration]}</type>${dots}</note>`);
          tiedFromPrev = new Set();
          continue;
        }
        const next = new Set<string>();
        const lyrics = lyricsXml(ev);
        ev.pitches.forEach((p, k) => {
          const key = `${p.step}${p.alter}${p.octave}`;
          const stop = tiedFromPrev.has(key);
          const start = !!ev.tie;
          if (start) next.add(key);
          const ties = (stop ? '<tie type="stop"/>' : '') + (start ? '<tie type="start"/>' : '');
          const tied = (stop ? '<tied type="stop"/>' : '') + (start ? '<tied type="start"/>' : '');
          out.push(`<note>${k > 0 ? '<chord/>' : ''}${pitchXml(p)}<duration>${dur}</duration>${ties}<voice>1</voice>`
            + `<type>${TYPE_NAMES[ev.duration]}</type>${dots}${tied ? `<notations>${tied}</notations>` : ''}${k === 0 ? lyrics : ''}</note>`);
        });
        tiedFromPrev = next;
      }
      out.push('</measure>');
    });
    out.push('</part>');
  });
  out.push('</score-partwise>');
  return out.join('\n');
}
