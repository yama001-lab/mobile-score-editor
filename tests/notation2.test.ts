// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor/editor';
import { buildSchedule } from '../src/audio/schedule';
import { toMusicXml } from '../src/export/musicxml';
import { parseMusicXml, readFlowWords } from '../src/import/musicxml';
import { renderScore } from '../src/render/render';
import { ottavaShifts, resolveSpanners } from '../src/model/marks';
import {
  NoteEvent, Score, clefAt, createScore, makeNote, measureAttrsAt, playOrder, reflowMeasures, updateMeasureAttrs,
} from '../src/model/score';

const C4 = { step: 'C' as const, alter: 0, octave: 4 };

// jsdom には SVG の大きさを測る getBBox がないので、文字数で見積もる
(SVGElement.prototype as unknown as { getBBox(): unknown }).getBBox = function (this: SVGElement) {
  return { x: 0, y: 0, width: (this.textContent?.length ?? 0) * 7, height: 12 };
};

function scoreWith(n: number): Score {
  const s = createScore();
  s.parts[0].measures = Array.from({ length: n }, (_, i) => ({ id: 'm' + i, events: [makeNote([C4], 'w')] }));
  return s;
}

/** C D E F を4分音符で入れた楽譜（テンポ60 = 1拍1秒） */
function fourNotes() {
  const e = new Editor(createScore({ tempo: 60 }));
  e.setMode('input');
  for (const m of [60, 62, 64, 65]) e.inputMidi(m);
  return e;
}
const ids = (e: Editor) => e.score.parts[0].measures[0].events.map((x) => x.id);

describe('D.C./D.S.・コーダ・Fine の演奏順', () => {
  it('D.C. で曲頭へ戻り、最後まで弾く（2回目は戻らない）', () => {
    const s = scoreWith(4);
    updateMeasureAttrs(s, 2, (a) => { a.jump = 'dc'; });
    expect(playOrder(s)).toEqual([0, 1, 2, 0, 1, 2, 3]);
  });

  it('D.C. al Fine は Fine で終わる（戻る前の Fine では終わらない）', () => {
    const s = scoreWith(5);
    updateMeasureAttrs(s, 1, (a) => { a.fine = true; });
    updateMeasureAttrs(s, 3, (a) => { a.jump = 'dc-fine'; });
    expect(playOrder(s)).toEqual([0, 1, 2, 3, 0, 1]);
  });

  it('D.S. al Coda：セーニョへ戻り、To Coda からコーダへとぶ', () => {
    const s = scoreWith(7);
    updateMeasureAttrs(s, 1, (a) => { a.segno = true; });
    updateMeasureAttrs(s, 2, (a) => { a.toCoda = true; });
    updateMeasureAttrs(s, 4, (a) => { a.jump = 'ds-coda'; });
    updateMeasureAttrs(s, 5, (a) => { a.coda = true; });
    expect(playOrder(s)).toEqual([0, 1, 2, 3, 4, 1, 2, 5, 6]);
  });

  it('戻ったあとはリピートを繰り返さず、最後のカッコだけ弾く', () => {
    const s = scoreWith(5);
    updateMeasureAttrs(s, 1, (a) => { a.volta = [1]; a.repeatEnd = true; });
    updateMeasureAttrs(s, 2, (a) => { a.volta = [2]; });
    updateMeasureAttrs(s, 3, (a) => { a.jump = 'dc'; });
    expect(playOrder(s)).toEqual([0, 1, 0, 2, 3, 0, 2, 3, 4]);
  });

  it('セーニョがなければ D.S. は曲頭へ', () => {
    const s = scoreWith(3);
    updateMeasureAttrs(s, 1, (a) => { a.jump = 'ds'; });
    expect(playOrder(s)).toEqual([0, 1, 0, 1, 2]);
  });

  it('再生もこの順に鳴る', () => {
    const s = scoreWith(3);
    updateMeasureAttrs(s, 1, (a) => { a.jump = 'dc'; });
    s.tempo = 60;
    expect(buildSchedule(s).notes.map((n) => n.time)).toEqual([0, 4, 8, 12, 16]);
  });

  it('D.S. などの文字を小節の記号に読み替える', () => {
    expect(readFlowWords('D.S. al Coda')).toEqual({ jump: 'ds-coda' });
    expect(readFlowWords('D.C. al Fine')).toEqual({ jump: 'dc-fine' });
    expect(readFlowWords('Da Capo')).toEqual({ jump: 'dc' });
    expect(readFlowWords('Fine')).toEqual({ fine: true });
    expect(readFlowWords('To Coda')).toEqual({ toCoda: true });
    expect(readFlowWords('rit.')).toBeNull();
  });

  it('エディタで付け外しでき、MusicXML で往復する', () => {
    const e = new Editor(scoreWith(6));
    e.setFlow(1, { segno: true });
    e.setFlow(2, { toCoda: true });
    e.setFlow(3, { jump: 'ds-coda' });
    e.setFlow(4, { coda: true, fine: true });
    e.setFlow(4, { fine: false });
    expect(measureAttrsAt(e.score, 4)).toEqual({ measure: 4, coda: true });
    const xml = toMusicXml(e.score);
    expect(xml).toContain('<segno/>');
    expect(xml).toContain('dalsegno="segno"');
    const back = parseMusicXml(xml).score;
    expect(playOrder(back)).toEqual(playOrder(e.score));
    expect(back.parts[0].measures.some((m) => measureEvents(m).some((x) => x.text))).toBe(false);
    e.setFlow(3, { jump: null });
    expect(measureAttrsAt(e.score, 3)).toBeUndefined();
  });

  it('描画できる', () => {
    const e = new Editor(scoreWith(4));
    e.setFlow(0, { segno: true });
    e.setFlow(1, { toCoda: true, fine: true });
    e.setFlow(2, { jump: 'ds-coda' });
    e.setFlow(3, { coda: true });
    const el = document.createElement('div');
    renderScore(el, e.score, { width: 900 });
    expect(el.textContent).toContain('D.S. al Coda');
    expect(el.textContent).toContain('To Coda');
    expect(el.textContent).toContain('Fine');
  });
});

const measureEvents = (m: { events: unknown[]; voice2?: unknown[] }) =>
  [...m.events, ...(m.voice2 ?? [])] as { text?: string }[];

describe('装飾音', () => {
  it('選んだ音符の前に足し、上下・臨時記号・消すができる', () => {
    const e = fourNotes();
    e.setMode('select');
    const [a] = ids(e);
    e.select(a);
    e.addGrace(true);
    const n = () => e.score.parts[0].measures[0].events[0] as NoteEvent;
    expect(n().graces).toEqual([{ pitches: [{ step: 'D', alter: 0, octave: 4 }], duration: '8', slash: true }]);
    e.shiftGrace(1);
    e.setGraceAccidental(1);
    expect(n().graces![0].pitches[0]).toEqual({ step: 'E', alter: 1, octave: 4 });
    e.addGrace(false);
    expect(n().graces).toHaveLength(2);
    e.removeGraces(true);
    expect(n().graces).toHaveLength(1);
    e.removeGraces();
    expect(n().graces).toBeUndefined();
  });

  it('小節の長さには数えず、再生では本音符の頭に短く鳴らす', () => {
    const e = fourNotes();
    e.setMode('select');
    e.select(ids(e)[1]);
    e.addGrace(true);
    const notes = buildSchedule(e.score).notes;
    expect(notes).toHaveLength(5);
    const grace = notes.find((x) => x.midi === 64 && x.time === 1)!;
    expect(grace.duration).toBeCloseTo(0.07);
    const main = notes.find((x) => x.midi === 62)!;
    expect(main.time).toBeCloseTo(1.07);
    expect(main.time + main.duration).toBeCloseTo(2);
  });

  it('長前打音は本音符の半分を取る', () => {
    const e = fourNotes();
    e.setMode('select');
    e.select(ids(e)[0]);
    e.addGrace(false);
    const main = buildSchedule(e.score).notes.find((x) => x.midi === 60)!;
    expect(main.time).toBeCloseTo(0.5);
  });

  it('MusicXML で往復し、描画できる', () => {
    const e = fourNotes();
    e.setMode('select');
    e.select(ids(e)[2]);
    e.addGrace(true);
    e.addGrace(false);
    const xml = toMusicXml(e.score);
    expect(xml).toContain('<grace slash="yes"/>');
    const back = parseMusicXml(xml);
    expect(back.warnings.join()).not.toContain('装飾音');
    const ev = back.score.parts[0].measures[0].events[2] as NoteEvent;
    expect(ev.graces).toEqual((e.score.parts[0].measures[0].events[2] as NoteEvent).graces);
    const el = document.createElement('div');
    expect(() => renderScore(el, e.score, { width: 800 })).not.toThrow();
  });

  it('範囲コピーで分けた音の後ろのかけらには付かない', () => {
    const e = new Editor(createScore());
    e.setMode('input');
    e.setInputDuration('h');
    e.inputMidi(60);
    e.setMode('select');
    e.select(ids(e)[0]);
    e.addGrace(true);
    // 拍子を変えて流し直すと、最初のかけらだけに装飾音が残る
    const m = reflowMeasures(e.score.parts[0].measures, 720);
    const notes = m.flatMap((x) => x.events).filter((x): x is NoteEvent => x.kind === 'note');
    expect(notes.length).toBeGreaterThan(1);
    expect(notes[0].graces).toHaveLength(1);
    expect(notes.slice(1).every((x) => !x.graces)).toBe(true);
  });
});

describe('途中の音部記号', () => {
  it('小節から変えて、描画・当たり判定・入力の高さに使う', () => {
    const e = new Editor(scoreWith(4));
    e.setClefAt(0, 2, 'bass');
    expect(clefAt(e.score.parts[0], 1)).toBe('treble');
    expect(clefAt(e.score.parts[0], 3)).toBe('bass');
    const el = document.createElement('div');
    const r = renderScore(el, e.score, { width: 900 });
    expect(r.hits.find((h) => h.measureIndex === 3)!.clef).toBe('bass');
    // 同じ音部記号の指定は残さない
    e.setClefAt(0, 3, 'bass');
    expect(e.score.parts[0].measures[3].clef).toBeUndefined();
    e.setClefAt(0, 2, null);
    expect(clefAt(e.score.parts[0], 3)).toBe('treble');
  });

  it('小節を消すと次の小節へ引き継ぎ、MusicXML で往復する', () => {
    const e = new Editor(scoreWith(4));
    e.setClefAt(0, 1, 'alto');
    e.setClefAt(0, 3, 'treble');
    e.removeMeasure(1);
    expect(e.score.parts[0].measures.map((m) => m.clef)).toEqual([undefined, 'alto', 'treble']);
    const xml = toMusicXml(e.score);
    const back = parseMusicXml(xml).score;
    expect(back.parts[0].measures.map((m) => m.clef)).toEqual([undefined, 'alto', 'treble']);
  });

  it('拍子を変えて小節を引き直しても、同じ時刻に残る', () => {
    const e = new Editor(scoreWith(4));
    e.setClefAt(0, 2, 'bass');
    e.setTimeSignature({ beats: 2, beatType: 4 });
    // 4/4 の3小節目の頭 = 2/4 の5小節目の頭
    expect(e.score.parts[0].measures[4].clef).toBe('bass');
    expect(clefAt(e.score.parts[0], 3)).toBe('treble');
  });
});

describe('8va・8vb・ペダル', () => {
  it('8va は1オクターブ上で鳴らし、範囲外は変えない', () => {
    const e = fourNotes();
    e.setMode('select');
    const [a] = ids(e);
    e.select(a);
    e.toggleSpanner('8va');
    e.toggleSpanner('8va');
    const [r] = resolveSpanners(e.score);
    expect(r.spanner.kind).toBe('8va');
    expect(ottavaShifts(e.score).size).toBe(3);
    expect(buildSchedule(e.score).notes.map((n) => n.midi)).toEqual([72, 74, 76, 65]);
  });

  it('8vb を付けると 8va は外れる（オクターブ記号どうしは重ねない）が、スラーとは重ねられる', () => {
    const e = fourNotes();
    e.setMode('select');
    const [a] = ids(e);
    e.select(a);
    e.toggleSpanner('slur');
    e.select(a);
    e.toggleSpanner('8va');
    e.select(a);
    e.toggleSpanner('8vb');
    expect(resolveSpanners(e.score).map((r) => r.spanner.kind).sort()).toEqual(['8vb', 'slur']);
    expect(buildSchedule(e.score).notes[0].midi).toBe(48);
  });

  it('ペダルの間に鳴り始めた音は、ペダルを上げるまで伸びる', () => {
    const e = fourNotes();
    e.setMode('select');
    const [a] = ids(e);
    e.select(a);
    e.toggleSpanner('pedal');
    e.toggleSpanner('pedal');
    const notes = buildSchedule(e.score).notes;
    // 1〜3拍目の音は3拍目の終わり（3秒）まで、4拍目はそのまま
    expect(notes.map((n) => +(n.time + n.duration).toFixed(3))).toEqual([3, 3, 3, 4]);
  });

  it('MusicXML で往復し、描画できる', () => {
    const e = fourNotes();
    e.setMode('select');
    const [a, , c] = ids(e);
    e.select(a);
    e.toggleSpanner('8va');
    e.select(c);
    e.toggleSpanner('pedal');
    const xml = toMusicXml(e.score);
    expect(xml).toContain('<octave-shift type="down" size="8"');
    expect(xml).toContain('<pedal type="start"');
    const back = parseMusicXml(xml).score;
    const kinds = resolveSpanners(back).map((r) => `${r.spanner.kind}:${r.from.index}-${r.to.index}`).sort();
    expect(kinds).toEqual(['8va:0-1', 'pedal:2-3']);
    const el = document.createElement('div');
    renderScore(el, e.score, { width: 800 });
    expect(el.textContent).toContain('8va');
  });

  it('クレッシェンドの強さの計算にはオクターブ記号・ペダルを混ぜない', () => {
    const e = fourNotes();
    e.setMode('select');
    e.select(ids(e)[0]);
    e.toggleSpanner('pedal');
    const v = buildSchedule(e.score).notes.map((n) => n.velocity);
    expect(new Set(v).size).toBe(1);
  });
});

describe('移調と装飾音', () => {
  it('楽譜全体の移調で装飾音も動く', () => {
    const e = fourNotes();
    e.setMode('select');
    e.select(ids(e)[0]);
    e.addGrace(true);
    e.transpose({ steps: 1, semitones: 2 });
    const n = e.score.parts[0].measures[0].events[0] as NoteEvent;
    expect(n.pitches[0]).toMatchObject({ step: 'D', octave: 4 });
    expect(n.graces![0].pitches[0]).toMatchObject({ step: 'E', alter: 0, octave: 4 });
  });
});

describe('差分描画と新しい記号', () => {
  it('前の段で音部記号を変えると、後ろの段も描き直す', async () => {
    const { ScoreView } = await import('../src/render/view');
    const e = new Editor(scoreWith(24));
    const el = document.createElement('div');
    const v = new ScoreView(el);
    v.render(e.score, { width: 600 });
    e.setClefAt(0, 1, 'bass');
    const r = v.render(e.score, { width: 600 });
    expect(r.hits.find((h) => h.measureIndex === 23)!.clef).toBe('bass');
  });
});
