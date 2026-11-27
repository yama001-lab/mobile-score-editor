// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor/editor';
import { toMusicXml } from '../src/export/musicxml';
import { parseMusicXml } from '../src/import/musicxml';
import { NoteEvent, createScore, makeNote, makeRest, measureCapacity, normalizeMeasure, reflowPart } from '../src/model/score';
import { formatChord, nextRehearsal, parseChord, stepLyricTarget } from '../src/model/texts';
import { renderScore } from '../src/render/render';

const C4 = { step: 'C' as const, alter: 0, octave: 4 };
const D4 = { step: 'D' as const, alter: 0, octave: 4 };

function songScore() {
  const s = createScore();
  const m = s.parts[0].measures[0];
  m.events = [makeNote([C4], 'q'), makeNote([D4], 'q', 0, true), makeNote([D4], 'q'), makeRest('q')];
  return s;
}

describe('コードネーム', () => {
  it('ルート・種類・ベースに分けられる', () => {
    expect(parseChord('F#m7/C#')).toMatchObject({ root: { step: 'F', alter: 1 }, suffix: 'm7', kind: 'minor-seventh', bass: { step: 'C', alter: 1 } });
    expect(parseChord('Bb')?.kind).toBe('major');
    expect(parseChord('Cmaj7')?.kind).toBe('major-seventh');
    expect(parseChord('Dm7-5')?.kind).toBe('half-diminished');
    expect(parseChord('Gsus4')?.kind).toBe('suspended-fourth');
    expect(parseChord('Cadd9')?.kind).toBe('other');
    expect(parseChord('ほげ')).toBeNull();
  });
  it('表示では # と b を ♯ ♭ にする', () => {
    expect(formatChord('Bb7')).toBe('B♭7');
    expect(formatChord('F#m7b5/C#')).toBe('F♯m7♭5/C♯');
    expect(formatChord('Cadd9')).toBe('Cadd9');
  });
});

describe('歌詞の入力', () => {
  it('次の音符へ進むとき、タイの続きと休符はとばす', () => {
    const s = songScore();
    s.parts[0].measures[1].events = [makeNote([C4], 'w')];
    const [a, b, , ] = s.parts[0].measures[0].events;
    expect(stepLyricTarget(s, 0, a.id, 1)).toBe(b.id);
    // b の次（タイの続き）と休符をとばして、次の小節の音符へ
    expect(stepLyricTarget(s, 0, b.id, 1)).toBe(s.parts[0].measures[1].events[0].id);
    expect(stepLyricTarget(s, 0, b.id, -1)).toBe(a.id);
    expect(stepLyricTarget(s, 0, a.id, -1)).toBeNull();
  });

  it('番ごとに入れて、消すと詰まる。元に戻すは1音節1回', () => {
    const ed = new Editor(songScore());
    const n = ed.score.parts[0].measures[0].events[0] as NoteEvent;
    ed.setLyric(n.id, 0, 'き', 'k');
    ed.setLyric(n.id, 0, 'きら', 'k');
    ed.setLyric(n.id, 1, 'ひ');
    expect((ed.score.parts[0].measures[0].events[0] as NoteEvent).lyrics).toEqual(['きら', 'ひ']);
    ed.setLyric(n.id, 1, '');
    expect((ed.score.parts[0].measures[0].events[0] as NoteEvent).lyrics).toEqual(['きら']);
    ed.undo();
    ed.undo();
    expect((ed.score.parts[0].measures[0].events[0] as NoteEvent).lyrics).toEqual(['きら']);
    ed.undo();
    expect((ed.score.parts[0].measures[0].events[0] as NoteEvent).lyrics).toBeUndefined();
  });

  it('次の練習番号は前の続き', () => {
    const s = createScore();
    expect(nextRehearsal(s, 3)).toBe('A');
    s.parts[0].measures[1].rehearsal = 'B';
    expect(nextRehearsal(s, 3)).toBe('C');
    s.parts[0].measures[1].rehearsal = '4';
    expect(nextRehearsal(s, 3)).toBe('5');
  });
});

describe('ほかの操作で文字が消えない', () => {
  it('拍子を変えても歌詞・コードネーム・練習番号が残る', () => {
    const s = songScore();
    const ev = s.parts[0].measures[0].events;
    (ev[0] as NoteEvent).lyrics = ['あ'];
    ev[0].chord = 'C';
    s.parts[0].measures[1].rehearsal = 'A';
    reflowPart(s.parts[0], measureCapacity({ beats: 2, beatType: 4 }));
    const first = s.parts[0].measures[0].events[0] as NoteEvent;
    expect(first.lyrics).toEqual(['あ']);
    expect(first.chord).toBe('C');
    // 4/4 の2小節目の頭 = 2/4 の3小節目の頭
    expect(s.parts[0].measures[2].rehearsal).toBe('A');
  });

  it('休符だけの小節をまとめても、最初の休符のコードネームは残る', () => {
    const m = { id: 'm', events: [makeRest('h'), makeRest('h')] };
    m.events[0].chord = 'Am';
    normalizeMeasure(m, 1920);
    expect(m.events).toHaveLength(1);
    expect(m.events[0].chord).toBe('Am');
  });

  it('音符を消して休符にしてもコードネームは残る', () => {
    const ed = new Editor(songScore());
    const n = ed.score.parts[0].measures[0].events[0];
    ed.setEventText(n.id, 'chord', 'G7');
    ed.setLyric(n.id, 0, 'ら');
    ed.select(n.id);
    ed.deleteSelected();
    const r = ed.score.parts[0].measures[0].events[0];
    expect(r.kind).toBe('rest');
    expect(r.chord).toBe('G7');
  });
});

describe('MusicXML', () => {
  it('歌詞（ハイフン・2番）、コードネーム、文字、練習番号を書き出して読み戻せる', () => {
    const s = songScore();
    const ev = s.parts[0].measures[0].events;
    (ev[0] as NoteEvent).lyrics = ['Twin-', 'ひ'];
    (ev[1] as NoteEvent).lyrics = ['kle'];
    ev[0].chord = 'F#m7/C#';
    ev[3].chord = 'Bb';
    ev[1].text = 'やさしく';
    s.parts[0].measures[1].rehearsal = 'A';
    const xml = toMusicXml(s);
    expect(xml).toContain('<syllabic>begin</syllabic><text>Twin</text>');
    expect(xml).toContain('<syllabic>end</syllabic><text>kle</text>');
    expect(xml).toContain('<kind text="m7">minor-seventh</kind>');
    expect(xml).toContain('<rehearsal>A</rehearsal>');

    const back = parseMusicXml(xml).score;
    const bev = back.parts[0].measures[0].events;
    expect((bev[0] as NoteEvent).lyrics).toEqual(['Twin-', 'ひ']);
    expect((bev[1] as NoteEvent).lyrics).toEqual(['kle']);
    expect(bev[0].chord).toBe('F#m7/C#');
    expect(bev[1].text).toBe('やさしく');
    expect(bev[3].chord).toBe('Bb');
    expect(back.parts[0].measures[1].rehearsal).toBe('A');
  });
});

describe('描画', () => {
  // jsdom には SVG の大きさを測る getBBox がないので、文字数で見積もる
  (SVGElement.prototype as unknown as { getBBox(): unknown }).getBBox = function (this: SVGElement) {
    return { x: 0, y: 0, width: (this.textContent?.length ?? 0) * 7, height: 12 };
  };
  it('歌詞などの文字を描き、当たり判定を返す。PDF用には描かずに集める', () => {
    const s = songScore();
    const ev = s.parts[0].measures[0].events;
    (ev[0] as NoteEvent).lyrics = ['さ-'];
    (ev[1] as NoteEvent).lyrics = ['くら'];
    ev[0].chord = 'C';
    s.parts[0].measures[0].rehearsal = 'A';
    const el = document.createElement('div');
    const res = renderScore(el, s, { width: 800, drawTitle: false });
    expect(res.textHits.map((h) => h.kind).sort()).toEqual(['chord', 'lyric', 'lyric', 'rehearsal']);
    expect(el.textContent).toContain('くら');
    // 歌詞は五線の下、コードネームは上
    const lyric = res.textHits.find((h) => h.kind === 'lyric')!;
    const chord = res.textHits.find((h) => h.kind === 'chord')!;
    const staff = res.hits[0];
    expect(lyric.y).toBeGreaterThan(staff.topLineY + staff.lineSpacing * 4);
    expect(chord.y + chord.h).toBeLessThan(staff.topLineY + 2);

    const items: string[] = [];
    const el2 = document.createElement('div');
    renderScore(el2, s, { width: 800, drawTitle: false, textSink: (t) => items.push(t.text) });
    expect(items).toEqual(expect.arrayContaining(['さ', '-', 'くら', 'C', 'A']));
    expect(el2.textContent).not.toContain('くら');
  });
});
