/** Score → MusicXML（score-partwise 3.1）。MuseScore などほかの楽譜ソフトへ持っていくため。 */
import { DurationType, PPQ } from '../model/duration';
import { Pitch } from '../model/pitch';
import {
  Clef, JUMP_TEXT, MusicEvent, Score, clefAt, clefChangeAt, eventTicks, keyAt, measureTicks, keyChangeAt, measureAttrsAt, tempoMarkAt,
  timeSigAt, timeSigChangeAt,
} from '../model/score';
import { parseChord, splitSyllable } from '../model/texts';
import { MarksXml, marksXml } from './musicxml-marks';

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

  const marks: MarksXml = marksXml(score);
  score.parts.forEach((part, pi) => {
    out.push(`<part id="P${pi + 1}">`);
    // 声部ごとの「前の音からタイが続いている音」
    const tiedFrom: Set<string>[] = [new Set(), new Set()];
    /** 声部・番ごとの、前の音節がハイフンでつながっているか */
    const hyphenOpen: boolean[][] = [[], []];
    const lyricsXml = (ev: MusicEvent, voice: number): string => {
      if (ev.kind !== 'note' || !ev.lyrics) return '';
      return ev.lyrics.map((raw, v) => {
        if (!raw) return '';
        const { text, hyphen } = splitSyllable(raw);
        const open = !!hyphenOpen[voice][v];
        hyphenOpen[voice][v] = hyphen;
        const syl = open ? (hyphen ? 'middle' : 'end') : hyphen ? 'begin' : 'single';
        return `<lyric number="${v + 1}"><syllabic>${syl}</syllabic><text>${esc(text)}</text></lyric>`;
      }).join('');
    };
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
      const clefXml = (c: Clef) => `<clef><sign>${CLEFS[c][0]}</sign><line>${CLEFS[c][1]}</line></clef>`;
      if (mi === 0) {
        out.push(`<attributes><divisions>${PPQ}</divisions><key><fifths>${keyAt(score, 0)}</fifths></key>`
          + timeXml + clefXml(clefAt(part, 0)) + '</attributes>');
      } else {
        const kc = keyChangeAt(score, mi);
        const tc = timeSigChangeAt(score, mi);
        const cc = clefChangeAt(part, mi);
        if (kc !== null || tc || cc) {
          out.push(`<attributes>${kc !== null ? `<key><fifths>${kc}</fifths></key>` : ''}${tc ? timeXml : ''}${cc ? clefXml(cc) : ''}</attributes>`);
        }
      }
      // セーニョ・コーダ（小節の頭）
      if (pi === 0 && attrs?.segno) out.push('<direction placement="above"><direction-type><segno/></direction-type><sound segno="segno"/></direction>');
      if (pi === 0 && attrs?.coda) out.push('<direction placement="above"><direction-type><coda/></direction-type><sound coda="coda"/></direction>');
      if (pi === 0 && m.rehearsal) {
        out.push(`<direction placement="above"><direction-type><rehearsal>${esc(m.rehearsal)}</rehearsal></direction-type></direction>`);
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
        events.forEach((ev, ei) => {
          const dur = eventTicks(ev);
          // 連符：<time-modification> と、頭と終わりに <tuplet>
          const t = ev.tuplet;
          const tupStart = !!t && events[ei - 1]?.tuplet?.id !== t.id;
          const tupStop = !!t && events[ei + 1]?.tuplet?.id !== t.id;
          const dots = '<dot/>'.repeat(ev.dots)
            + (t ? `<time-modification><actual-notes>${t.actual}</actual-notes><normal-notes>${t.normal}</normal-notes></time-modification>` : '');
          const tupXml = (tupStart ? '<tuplet type="start" bracket="yes"/>' : '') + (tupStop ? '<tuplet type="stop"/>' : '');
          const before = textsBefore(ev);
          if (before) out.push(before);
          out.push(...marks.before(ev));
          if (ev.kind === 'rest') {
            const n = marks.notations(ev) + tupXml;
            out.push(`<note><rest/><duration>${dur}</duration><voice>${voiceNo}</voice><type>${TYPE_NAMES[ev.duration]}</type>${dots}`
              + `${n ? `<notations>${n}</notations>` : ''}</note>`);
            out.push(...marks.after(ev));
            tiedFromPrev = new Set();
            return;
          }
          const next = new Set<string>();
          const lyrics = lyricsXml(ev, v);
          // 装飾音は本音符の前に、長さ（duration）なしで書く
          for (const g of ev.graces ?? []) {
            g.pitches.forEach((p, k) => {
              out.push(`<note>${k > 0 ? '<chord/>' : ''}<grace${g.slash ? ' slash="yes"' : ''}/>${pitchXml(p)}<voice>${voiceNo}</voice>`
                + `<type>${TYPE_NAMES[g.duration]}</type>${stem}</note>`);
            });
          }
          ev.pitches.forEach((p, k) => {
            const key = `${p.step}${p.alter}${p.octave}`;
            const stop = tiedFromPrev.has(key);
            const start = !!ev.tie;
            if (start) next.add(key);
            const ties = (stop ? '<tie type="stop"/>' : '') + (start ? '<tie type="start"/>' : '');
            const tied = (stop ? '<tied type="stop"/>' : '') + (start ? '<tied type="start"/>' : '')
              + (k === 0 ? marks.notations(ev) + tupXml : '');
            out.push(`<note>${k > 0 ? '<chord/>' : ''}${pitchXml(p)}<duration>${dur}</duration>${ties}<voice>${voiceNo}</voice>`
              + `<type>${TYPE_NAMES[ev.duration]}</type>${dots}${stem}${tied ? `<notations>${tied}</notations>` : ''}${k === 0 ? lyrics : ''}</note>`);
          });
          out.push(...marks.after(ev));
          tiedFromPrev = next;
        });
        tiedFrom[v] = tiedFromPrev;
      });
      if (!m.voice2) tiedFrom[1] = new Set();
      // Fine・To Coda・D.C./D.S.（小節の終わり）
      if (pi === 0 && attrs) {
        const words = (w: string, sound: string) =>
          `<direction placement="above"><direction-type><words>${esc(w)}</words></direction-type><sound ${sound}/></direction>`;
        if (attrs.fine) out.push(words('Fine', 'fine="yes"'));
        if (attrs.toCoda) out.push(words('To Coda', 'tocoda="coda"'));
        if (attrs.jump) out.push(words(JUMP_TEXT[attrs.jump], attrs.jump.startsWith('ds') ? 'dalsegno="segno"' : 'dacapo="yes"'));
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
