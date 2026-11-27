// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor/editor';
import { buildSchedule } from '../src/audio/schedule';
import { toMusicXml } from '../src/export/musicxml';
import { parseMusicXml } from '../src/import/musicxml';
import {
  Score, capacityAt, createScore, keyAt, makeNote, measureTicks, playOrder, timeSigAt, updateMeasureAttrs,
} from '../src/model/score';

const C4 = { step: 'C' as const, alter: 0, octave: 4 };
const F4 = { step: 'F' as const, alter: 0, octave: 4 };

function scoreWith(n: number): Score {
  const s = createScore();
  while (s.parts[0].measures.length < n) s.parts[0].measures.push({ id: 'x' + s.parts[0].measures.length, events: [] });
  s.parts[0].measures = s.parts[0].measures.slice(0, n).map((m, i) => ({ id: 'm' + i, events: [makeNote([C4], 'w')] }));
  return s;
}

function checkFilled(s: Score) {
  for (const p of s.parts) p.measures.forEach((m, i) => expect(measureTicks(m)).toBe(capacityAt(s, i)));
}

describe('リピートの演奏順', () => {
  it(':| で曲頭へ戻る', () => {
    const s = scoreWith(4);
    updateMeasureAttrs(s, 1, (a) => { a.repeatEnd = true; });
    expect(playOrder(s)).toEqual([0, 1, 0, 1, 2, 3]);
  });

  it('|: から :| を繰り返し、回数も指定できる', () => {
    const s = scoreWith(5);
    updateMeasureAttrs(s, 1, (a) => { a.repeatStart = true; });
    updateMeasureAttrs(s, 2, (a) => { a.repeatEnd = true; a.repeatTimes = 3; });
    expect(playOrder(s)).toEqual([0, 1, 2, 1, 2, 1, 2, 3, 4]);
  });

  it('1番・2番カッコ', () => {
    const s = scoreWith(6);
    updateMeasureAttrs(s, 0, (a) => { a.repeatStart = true; });
    updateMeasureAttrs(s, 2, (a) => { a.volta = [1]; });
    updateMeasureAttrs(s, 3, (a) => { a.volta = [1]; a.repeatEnd = true; });
    updateMeasureAttrs(s, 4, (a) => { a.volta = [2]; });
    expect(playOrder(s)).toEqual([0, 1, 2, 3, 0, 1, 4, 5]);
  });

  it('1.2.番カッコと3番カッコ', () => {
    const s = scoreWith(4);
    updateMeasureAttrs(s, 1, (a) => { a.volta = [1, 2]; a.repeatEnd = true; });
    updateMeasureAttrs(s, 2, (a) => { a.volta = [3]; });
    expect(playOrder(s)).toEqual([0, 1, 0, 1, 0, 2, 3]);
  });

  it('2つ目のリピートは回数を数え直す', () => {
    const s = scoreWith(4);
    updateMeasureAttrs(s, 0, (a) => { a.repeatEnd = true; });
    updateMeasureAttrs(s, 2, (a) => { a.repeatStart = true; });
    updateMeasureAttrs(s, 3, (a) => { a.repeatEnd = true; });
    expect(playOrder(s)).toEqual([0, 0, 1, 2, 3, 2, 3]);
  });

  it('再生はリピートをたどり、途中から始めることもできる', () => {
    const s = scoreWith(3);
    updateMeasureAttrs(s, 1, (a) => { a.repeatEnd = true; });
    const sch = buildSchedule(s);
    expect(sch.notes).toHaveLength(5);
    expect(sch.length).toBeCloseTo(5 * 4 * 0.6);
    expect(buildSchedule(s, 1).notes).toHaveLength(4); // 1, 0, 1, 2
    expect(buildSchedule(s, 2).notes).toHaveLength(1);
  });
});

describe('弱起', () => {
  it('1小節目を短くし、休符のあとに書いた音を残す', () => {
    const e = new Editor(createScore());
    e.setInputDuration('h');
    e.inputRest();
    e.setInputDuration('q');
    e.inputRest();
    e.inputDiatonic(4 * 7 + 4); // G4（4拍目）
    e.setPickup(480);
    expect(e.score.pickup).toBe(480);
    const m0 = e.score.parts[0].measures[0].events;
    expect(m0).toHaveLength(1);
    expect(m0[0].kind === 'note' && m0[0].pitches[0].step).toBe('G');
    checkFilled(e.score);
    // 再生でも短い
    expect(buildSchedule(e.score).notes[0].time).toBe(0);
    e.setPickup(0);
    expect(e.score.pickup).toBeUndefined();
    checkFilled(e.score);
    const back = e.score.parts[0].measures[0].events;
    expect(back[back.length - 1].kind).toBe('note');
  });

  it('入力は弱起の小節の長さで次の小節へ進む', () => {
    const e = new Editor(createScore());
    e.setPickup(480);
    e.inputDiatonic(4 * 7);
    expect(e.cursor.measureIndex).toBe(1);
    e.setInputDuration('h');
    e.inputDiatonic(4 * 7);
    checkFilled(e.score);
  });
});

describe('途中の拍子・調号の変更', () => {
  it('途中から拍子を変えると、その後ろだけ小節を引き直す', () => {
    const e = new Editor(createScore());
    e.score.parts[0].measures.forEach((m) => { m.events = [makeNote([C4], 'w')]; });
    e.score.tempoMarks = [{ measure: 6, tempo: 80 }];
    e.setTimeSignatureAt(4, { beats: 2, beatType: 4 });
    const s = e.score;
    expect(timeSigAt(s, 3)).toEqual({ beats: 4, beatType: 4 });
    expect(timeSigAt(s, 4)).toEqual({ beats: 2, beatType: 4 });
    expect(s.parts[0].measures).toHaveLength(4 + 8);
    checkFilled(s);
    // 6小節目（もとの7小節目の頭）は 4 + 2*2 = 8
    expect(s.tempoMarks).toEqual([{ measure: 8, tempo: 80 }]);
    // 消すともとに戻る
    e.setTimeSignatureAt(4, null);
    expect(s.measureAttrs).toBeUndefined();
    expect(e.score.parts[0].measures).toHaveLength(8);
    checkFilled(e.score);
  });

  it('途中の拍子変更の後ろに次の変更があれば、その手前までを引き直す', () => {
    const e = new Editor(createScore());
    e.setTimeSignatureAt(6, { beats: 3, beatType: 4 });
    e.setTimeSignatureAt(2, { beats: 2, beatType: 4 });
    // 2..5 の4小節（4/4）が 2/4 の8小節になり、3/4 は 10 小節目から
    expect(timeSigAt(e.score, 9)).toEqual({ beats: 2, beatType: 4 });
    expect(timeSigAt(e.score, 10)).toEqual({ beats: 3, beatType: 4 });
    checkFilled(e.score);
  });

  it('途中の調号変更は音の高さを変えない', () => {
    const e = new Editor(createScore());
    e.inputDiatonic(4 * 7 + 3); // F4
    e.setKeyAt(1, 1);
    expect(keyAt(e.score, 0)).toBe(0);
    expect(keyAt(e.score, 1)).toBe(1);
    expect(e.score.parts[0].measures[0].events[0]).toMatchObject({ pitches: [F4] });
    // 2小節目に入れたファは調号どおり♯が付く
    e.setCursor({ partIndex: 0, measureIndex: 1, eventIndex: 0 });
    e.inputDiatonic(4 * 7 + 3);
    expect(e.score.parts[0].measures[1].events[0]).toMatchObject({ pitches: [{ step: 'F', alter: 1 }] });
    e.setKeyAt(1, 0); // 前と同じ調にしたら変更は消える
    expect(e.score.measureAttrs).toBeUndefined();
  });

  it('小節を挿入・削除すると記号もずれる', () => {
    const e = new Editor(createScore());
    e.setKeyAt(3, 2);
    e.setRepeat(5, { repeatEnd: true });
    e.addMeasure(0);
    expect(e.score.measureAttrs!.map((a) => a.measure)).toEqual([4, 6]);
    e.removeMeasure(4);
    // 調号の変更は次の小節へ引き継ぐ
    expect(keyAt(e.score, 4)).toBe(2);
    expect(keyAt(e.score, 3)).toBe(0);
    expect(e.score.measureAttrs!.find((a) => a.repeatEnd)!.measure).toBe(5);
  });
});

describe('MusicXML と表示', () => {
  function sample(): Score {
    const e = new Editor(createScore({ grandStaff: true }));
    e.setPickup(480);
    e.setRepeat(1, { repeatStart: true });
    e.setRepeat(2, { volta: [1], repeatEnd: true });
    e.setRepeat(3, { volta: [2] });
    e.setKeyAt(4, -3);
    e.setTimeSignatureAt(5, { beats: 3, beatType: 4 });
    e.setCursor({ partIndex: 0, measureIndex: 0, eventIndex: 0 });
    e.inputDiatonic(4 * 7 + 4);
    return e.score;
  }

  it('書き出して取り込むと、リピート・カッコ・弱起・途中の変更が戻る', () => {
    const s = sample();
    const xml = toMusicXml(s);
    expect(xml).toContain('implicit="yes"');
    expect(xml).toContain('<repeat direction="forward"/>');
    expect(xml).toContain('<ending number="1" type="stop"/>');
    expect(xml).toContain('<ending number="2" type="discontinue"/>');
    const { score: back, warnings } = parseMusicXml(xml);
    expect(warnings).toEqual([]);
    expect(back.pickup).toBe(480);
    expect(back.measureAttrs).toEqual(s.measureAttrs);
    expect(back.parts[0].measures).toHaveLength(s.parts[0].measures.length);
    checkFilled(back);
    expect(playOrder(back)).toEqual(playOrder(s));
  });
});
