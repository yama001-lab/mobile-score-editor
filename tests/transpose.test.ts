import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor/editor';
import { createScore } from '../src/model/score';
import { intervalBetweenKeys, tonicOf, transposeKey, transposePitch } from '../src/model/transpose';

const P = (step: string, alter: number, octave: number) => ({ step: step as 'C', alter, octave });

describe('移調', () => {
  it('音程で綴りまで正しく動かす', () => {
    expect(transposePitch(P('D', 0, 4), { steps: 2, semitones: 4 })).toEqual(P('F', 1, 4)); // 長3度上
    expect(transposePitch(P('C', 0, 5), { steps: -1, semitones: -1 })).toEqual(P('B', 0, 4)); // 短2度下
    expect(transposePitch(P('E', 0, 4), { steps: 3, semitones: 5 })).toEqual(P('A', 0, 4));
  });
  it('調の主音', () => {
    expect(tonicOf(6)).toEqual(P('F', 1, 4));
    expect(tonicOf(-3)).toEqual(P('E', -1, 4));
  });
  it('調を指定したときの音程', () => {
    expect(intervalBetweenKeys(0, 2, 'up')).toEqual({ steps: 1, semitones: 2 }); // ハ→ニ 上
    expect(intervalBetweenKeys(0, 2, 'down')).toEqual({ steps: -6, semitones: -10 });
    expect(intervalBetweenKeys(0, -2, 'nearest')).toEqual({ steps: -1, semitones: -2 }); // ハ→変ロ 下
    expect(intervalBetweenKeys(0, 1, 'nearest')).toEqual({ steps: -3, semitones: -5 }); // ハ→ト 4度下が近い
  });
  it('調号が7つを超えるときは異名同音の調にする', () => {
    // ホ長調(4♯)を長3度上げると嬰ト長調(8♯)→変イ長調(4♭)
    const k = transposeKey(4, { steps: 2, semitones: 4 });
    expect(k.fifths).toBe(-4);
    expect(k.interval.semitones).toBe(4);
  });
  it('楽譜全体を移調すると調号も変わり、声部2も動く', () => {
    const e = new Editor(createScore());
    e.inputDiatonic(28); // C4
    e.setCursorAtTick(0, 0, 1, 0);
    e.inputDiatonic(26); // A3 声部2
    e.transpose({ steps: 1, semitones: 2 });
    const m = e.score.parts[0].measures[0];
    expect(e.score.keyFifths).toBe(2);
    expect(m.events[0].kind === 'note' && m.events[0].pitches[0]).toEqual(P('D', 0, 4));
    expect(m.voice2![0].kind === 'note' && m.voice2![0].pitches[0]).toEqual(P('B', 0, 3));
  });
  it('選んだ音符だけ移調すると調号はそのまま', () => {
    const e = new Editor(createScore());
    e.inputDiatonic(28);
    e.inputDiatonic(28);
    const id = e.score.parts[0].measures[0].events[1].id;
    e.transpose({ steps: 2, semitones: 3 }, { kind: 'ids', ids: [id] });
    const evs = e.score.parts[0].measures[0].events;
    expect(e.score.keyFifths).toBe(0);
    expect(evs[0].kind === 'note' && evs[0].pitches[0]).toEqual(P('C', 0, 4));
    expect(evs[1].kind === 'note' && evs[1].pitches[0]).toEqual(P('E', -1, 4));
  });
});
