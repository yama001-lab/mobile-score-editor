// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { jsPDF } from 'jspdf';
import { parseMusicXml } from '../src/import/musicxml';
import { importBytes } from '../src/import/index';
import { encodeScore, extractEmbeddedScore } from '../src/import/embed';
import { toMusicXml } from '../src/export/musicxml';
import { createScore, makeNote, measureCapacity, measureTicks, Score } from '../src/model/score';

const note = (step: string, octave: number, dur: number, type: string, extra = '') =>
  `<note>${extra.includes('<chord/>') ? '<chord/>' : ''}<pitch><step>${step}</step><octave>${octave}</octave></pitch>`
  + `<duration>${dur}</duration>${extra.replace('<chord/>', '')}<type>${type}</type></note>`;

const wrap = (parts: string, partList: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <work><work-title>きらきら星</work-title></work>
  <identification><creator type="composer">フランス民謡</creator></identification>
  <part-list>${partList}</part-list>
  ${parts}
</score-partwise>`;

function check(score: Score) {
  const cap = measureCapacity(score.timeSignature);
  for (const p of score.parts) for (const m of p.measures) expect(measureTicks(m)).toBe(cap);
  const n = score.parts[0].measures.length;
  for (const p of score.parts) expect(p.measures.length).toBe(n);
}

describe('MusicXML の取り込み', () => {
  it('タイトル・拍子・調号・テンポ・音を読む', () => {
    const xml = wrap(`<part id="P1">
      <measure number="1">
        <attributes><divisions>2</divisions><key><fifths>1</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time>
          <clef><sign>G</sign><line>2</line></clef></attributes>
        <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>90</per-minute></metronome></direction-type><sound tempo="90"/></direction>
        ${note('G', 4, 2, 'quarter')}
        ${note('B', 4, 2, 'quarter', '<chord/>')}
        ${note('A', 4, 1, 'eighth')}
        <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>1</duration><type>eighth</type></note>
        ${note('E', 4, 2, 'quarter', '<tie type="start"/>')}
      </measure>
      <measure number="2">
        <direction><sound tempo="120"/></direction>
        ${note('E', 4, 2, 'quarter', '<tie type="stop"/>')}
        <note><rest/><duration>4</duration><type>half</type></note>
      </measure>
      <measure number="3"><note><rest measure="yes"/><duration>6</duration></note></measure>
      <measure number="4"><direction><sound tempo="120"/></direction><note><rest measure="yes"/><duration>6</duration></note></measure>
    </part>`, '<score-part id="P1"><part-name>Flute</part-name></score-part>');
    const { score, warnings } = parseMusicXml(xml);
    expect(score.title).toBe('きらきら星');
    expect(score.composer).toBe('フランス民謡');
    expect(score.timeSignature).toEqual({ beats: 3, beatType: 4 });
    expect(score.keyFifths).toBe(1);
    expect(score.tempo).toBe(90);
    expect(score.tempoMarks).toEqual([{ measure: 1, tempo: 120 }]);
    expect(score.parts).toHaveLength(1);
    expect(score.parts[0].name).toBe('Flute');
    expect(score.parts[0].measures).toHaveLength(4);
    check(score);
    const [a, b, c, d] = score.parts[0].measures[0].events;
    expect(a.kind === 'note' && a.pitches.map((p) => p.step)).toEqual(['G', 'B']);
    expect(b.duration).toBe('8');
    expect(c.kind === 'note' && c.pitches[0]).toEqual({ step: 'F', alter: 1, octave: 4 });
    expect(d.kind === 'note' && d.tie).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('ピアノの2段は右手・左手の2パートに分け、弱起は1小節目の後ろに寄せる', () => {
    const xml = wrap(`<part id="P1">
      <measure number="0" implicit="yes">
        <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves>
          <clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>
        ${note('G', 4, 1, 'quarter', '<voice>1</voice><staff>1</staff>')}
        <backup><duration>1</duration></backup>
        <note><rest/><duration>1</duration><voice>5</voice><type>quarter</type><staff>2</staff></note>
      </measure>
      <measure number="1">
        ${note('C', 5, 4, 'whole', '<voice>1</voice><staff>1</staff>')}
        <backup><duration>4</duration></backup>
        ${note('E', 5, 2, 'half', '<voice>2</voice><staff>1</staff>')}
        ${note('D', 5, 2, 'half', '<voice>2</voice><staff>1</staff>')}
        <backup><duration>4</duration></backup>
        ${note('C', 3, 4, 'whole', '<voice>5</voice><staff>2</staff>')}
      </measure>
    </part>`, '<score-part id="P1"><part-name>Piano</part-name></score-part>');
    const { score, warnings } = parseMusicXml(xml);
    expect(score.parts.map((p) => [p.name, p.clef])).toEqual([['右手', 'treble'], ['左手', 'bass']]);
    check(score);
    expect(score.parts[0].measures).toHaveLength(2);
    const m0 = score.parts[0].measures[0].events;
    expect(m0[m0.length - 1].kind === 'note' && m0[m0.length - 1]).toMatchObject({ duration: 'q', pitches: [{ step: 'G' }] });
    expect(m0[0].kind).toBe('rest');
    expect(score.parts[0].measures[1].events).toHaveLength(1);
    expect(warnings.some((w) => w.includes('声部'))).toBe(true);
  });

  it('3連符は近い長さに丸めて小節を埋める', () => {
    const tri = (s: string) => note(s, 4, 2, 'eighth', '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>');
    const xml = wrap(`<part id="P1"><measure number="1">
      <attributes><divisions>6</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
      ${tri('C')}${tri('D')}${tri('E')}${note('F', 4, 6, 'quarter')}
    </measure></part>`, '<score-part id="P1"><part-name></part-name></score-part>');
    const { score, warnings } = parseMusicXml(xml);
    check(score);
    const notes = score.parts[0].measures[0].events.filter((e) => e.kind === 'note');
    expect(notes.map((n) => n.kind === 'note' && n.pitches[0].step)).toContain('F');
    expect(warnings.some((w) => w.includes('連符'))).toBe(true);
  });

  it('このアプリの MusicXML 書き出しを読み戻すと同じ音になる', () => {
    const s = createScore({ grandStaff: true, title: 'テスト', tempo: 132, keyFifths: -2 });
    s.parts[0].measures[0].events = [
      makeNote([{ step: 'B', alter: -1, octave: 4 }, { step: 'D', alter: 0, octave: 5 }], 'h', 1, true),
      makeNote([{ step: 'B', alter: -1, octave: 4 }, { step: 'D', alter: 0, octave: 5 }], 'q'),
    ];
    s.tempoMarks = [{ measure: 3, tempo: 80 }];
    const back = parseMusicXml(toMusicXml(s)).score;
    check(back);
    expect(back.title).toBe('テスト');
    expect(back.tempo).toBe(132);
    expect(back.tempoMarks).toEqual([{ measure: 3, tempo: 80 }]);
    expect(back.keyFifths).toBe(-2);
    expect(back.parts.map((p) => p.clef)).toEqual(['treble', 'bass']);
    expect(back.parts[0].measures).toHaveLength(8);
    const strip = (sc: Score) => sc.parts.map((p) => p.measures.map((m) => m.events.map((e) =>
      e.kind === 'note' ? [e.duration, e.dots, e.pitches, !!e.tie] : [e.duration, e.dots])));
    expect(strip(back)).toEqual(strip(s));
  });

  it('壊れたファイルはわかる言葉で断る', () => {
    expect(() => parseMusicXml('<html></html>')).toThrow('MusicXML');
    expect(() => parseMusicXml('<score-partwise><part-list/></score-partwise>')).toThrow('パート');
  });
});

describe('ファイルの種類の見分け', () => {
  const s = createScore({ title: 'PDFテスト' });
  s.parts[0].measures[0].events = [makeNote([{ step: 'C', alter: 0, octave: 4 }], 'w')];

  it('このアプリの PDF からは埋め込んだ楽譜を取り出す', async () => {
    const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    doc.text('score', 40, 40);
    doc.setProperties({ creator: 'mobile-score-editor', keywords: encodeScore(s) });
    const pdf = new Uint8Array(doc.output('arraybuffer'));
    expect(extractEmbeddedScore(pdf)).toEqual(JSON.parse(JSON.stringify(s)));
    const r = await importBytes(pdf, 'x.pdf', 'application/pdf');
    expect(r.kind).toBe('score');
    expect(r.kind === 'score' && r.score.parts[0].measures[0].events[0]).toMatchObject({ duration: 'w' });
  });

  it('ほかの PDF や写真は読み取りソフトの案内にする', async () => {
    const doc = new jsPDF();
    doc.text('hello', 10, 10);
    expect(await importBytes(new Uint8Array(doc.output('arraybuffer')), 'other.pdf')).toEqual({ kind: 'needs-omr', reason: 'pdf' });
    expect(await importBytes(new Uint8Array([0xff, 0xd8]), 'photo.jpg', 'image/jpeg')).toEqual({ kind: 'needs-omr', reason: 'image' });
  });
});
