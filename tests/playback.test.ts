import { describe, expect, it } from 'vitest';
import { buildSchedule } from '../src/audio/schedule';
import { Editor } from '../src/editor/editor';
import { createScore, measureTicks } from '../src/model/score';

describe('再生の予定', () => {
  it('テンポに合わせて音の時刻と長さを決める', () => {
    const e = new Editor(createScore({ tempo: 120 }));
    e.inputMidi(60);
    e.inputMidi(62);
    const s = buildSchedule(e.score);
    expect(s.notes.map((n) => [n.midi, n.time, n.duration])).toEqual([[60, 0, 0.5], [62, 0.5, 0.5]]);
    expect(s.length).toBe(8 * 2); // 4/4 を8小節、1小節2秒
  });

  it('タイでつながった音は1つの長い音になる', () => {
    const e = new Editor(createScore({ tempo: 60 }));
    e.inputMidi(64);
    e.toggleTie();
    const s = buildSchedule(e.score);
    expect(s.notes).toHaveLength(1);
    expect(s.notes[0].duration).toBe(2);
  });

  it('途中の小節から再生できる', () => {
    const e = new Editor(createScore({ tempo: 60 }));
    e.setInputDuration('w');
    e.inputMidi(60);
    e.inputMidi(67);
    const s = buildSchedule(e.score, 1);
    expect(s.notes[0]).toMatchObject({ midi: 67, time: 0 });
  });

  it('パートごとの音色を使う', () => {
    const e = new Editor(createScore({ grandStaff: true }));
    e.setPartInstrument(1, 'synth');
    e.setCursor({ partIndex: 1, measureIndex: 0, eventIndex: 0 });
    e.inputMidi(48);
    expect(buildSchedule(e.score).notes[0]).toMatchObject({ midi: 48, instrument: 'synth', partIndex: 1 });
  });
});

describe('鍵盤からの入力', () => {
  it('chord を付けると直前の音に重なり、カーソルは進まない', () => {
    const e = new Editor(createScore());
    e.inputMidi(60);
    const cursor = { ...e.cursor };
    e.inputMidi(64, true);
    e.inputMidi(67, true);
    const first = e.score.parts[0].measures[0].events[0];
    expect(first.kind === 'note' && first.pitches.map((p) => p.step)).toEqual(['C', 'E', 'G']);
    expect(e.cursor).toEqual(cursor);
  });

  it('入力モードのタイは、同じ高さの音を足してつなぐ', () => {
    const e = new Editor(createScore());
    e.setInputDuration('h');
    e.inputMidi(62);
    e.toggleTie();
    const [a, b] = e.score.parts[0].measures[0].events;
    expect(a.kind === 'note' && a.tie).toBe(true);
    expect(b.kind === 'note' && b.pitches[0].step).toBe('D');
    expect(e.score.parts[0].measures.every((m) => measureTicks(m) === e.capacity)).toBe(true);
    // 元に戻すは1回で済む
    e.undo();
    const evs = e.score.parts[0].measures[0].events;
    expect(evs[0].kind === 'note' && !evs[0].tie).toBe(true);
    expect(evs[1].kind).toBe('rest');
  });

  it('調号に合わせて黒鍵の綴りを選ぶ', () => {
    const e = new Editor(createScore({ keyFifths: -2 }));
    e.inputMidi(70);
    const n = e.score.parts[0].measures[0].events[0];
    expect(n.kind === 'note' && n.pitches[0]).toEqual({ step: 'B', alter: -1, octave: 4 });
  });
});

describe('テンポ', () => {
  it('途中のテンポ変更が再生の時刻に反映される', () => {
    const e = new Editor(createScore({ tempo: 60 }));
    e.setInputDuration('w');
    e.inputMidi(60);
    e.inputMidi(62);
    e.inputMidi(64);
    e.setTempo(1, 120);
    const s = buildSchedule(e.score);
    expect(s.notes.map((n) => [n.time, n.duration])).toEqual([[0, 4], [4, 2], [6, 2]]);
    // 途中から再生しても、その時点のテンポを使う
    expect(buildSchedule(e.score, 2).notes[0]).toMatchObject({ midi: 64, time: 0, duration: 2 });
  });

  it('テンポ変更をまたぐタイは、それぞれのテンポで長さを足す', () => {
    const e = new Editor(createScore({ tempo: 60 }));
    e.setInputDuration('w');
    e.inputMidi(60);
    e.toggleTie();
    e.setTempo(1, 120);
    expect(buildSchedule(e.score).notes).toEqual([expect.objectContaining({ time: 0, duration: 6 })]);
  });

  it('小節の追加・削除でテンポ変更の位置がずれない', () => {
    const e = new Editor(createScore());
    e.setTempo(3, 80);
    e.addMeasure(0);
    expect(e.score.tempoMarks).toEqual([{ measure: 4, tempo: 80 }]);
    e.removeMeasure(1);
    e.removeMeasure(3);
    expect(e.score.tempoMarks).toEqual([{ measure: 3, tempo: 80 }]);
    e.setTempo(0, 90);
    expect(e.score.tempo).toBe(90);
    e.removeTempo(3);
    expect(e.score.tempoMarks).toEqual([]);
  });
});
