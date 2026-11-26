import { describe, expect, it } from 'vitest';
import { decompose, ticksOf } from '../src/model/duration';
import { fromMidi, toMidi } from '../src/model/pitch';
import { createScore, measureTicks, measureCapacity, reflowPart } from '../src/model/score';
import { Editor } from '../src/editor/editor';

describe('音価', () => {
  it('付点を含めてティックを計算する', () => {
    expect(ticksOf('q')).toBe(480);
    expect(ticksOf('h', 1)).toBe(1440);
  });
  it('長さを書ける音価に分解する', () => {
    expect(decompose(1440)).toEqual([{ duration: 'h', dots: 1 }]);
    expect(decompose(1200)).toEqual([{ duration: 'h', dots: 0 }, { duration: '8', dots: 0 }]);
  });
});

describe('音高', () => {
  it('MIDI番号と相互に変換する', () => {
    expect(toMidi({ step: 'C', alter: 0, octave: 4 })).toBe(60);
    expect(fromMidi(66, 1)).toEqual({ step: 'F', alter: 1, octave: 4 });
    expect(fromMidi(70, -1)).toEqual({ step: 'B', alter: -1, octave: 4 });
  });
});

describe('編集', () => {
  const full = (e: Editor) => e.score.parts.every((p) => p.measures.every((m) => measureTicks(m) === e.capacity));

  it('入力すると小節が常に埋まった状態を保ち、カーソルが進む', () => {
    const e = new Editor(createScore());
    e.inputDiatonic(28); // C4
    e.inputDiatonic(29);
    expect(e.score.parts[0].measures[0].events.map((x) => x.kind)).toEqual(['note', 'note', 'rest']);
    expect(e.cursor.eventIndex).toBe(2);
    expect(full(e)).toBe(true);
  });

  it('小節をまたぐ音はタイで分ける', () => {
    const e = new Editor(createScore());
    e.setInputDuration('h');
    e.toggleDot();
    e.inputDiatonic(28);
    e.inputDiatonic(28); // 付点2分×2 = 6拍
    const [m1, m2] = e.score.parts[0].measures;
    expect(m1.events[1]).toMatchObject({ kind: 'note', duration: 'q', tie: true });
    expect(m2.events[0]).toMatchObject({ kind: 'note', duration: 'h' });
    expect(full(e)).toBe(true);
  });

  it('削除すると休符になり、元に戻せる', () => {
    const e = new Editor(createScore());
    e.inputDiatonic(30);
    e.deleteSelected();
    expect(e.score.parts[0].measures[0].events.every((x) => x.kind === 'rest')).toBe(true);
    e.undo();
    expect(e.score.parts[0].measures[0].events[0].kind).toBe('note');
    e.redo();
    expect(e.score.parts[0].measures[0].events[0].kind).toBe('rest');
  });

  it('音価を変えても小節の長さは変わらない', () => {
    const e = new Editor(createScore());
    e.inputDiatonic(30);
    e.setMode('select');
    e.setInputDuration('h');
    expect(e.score.parts[0].measures[0].events[0]).toMatchObject({ duration: 'h' });
    e.setInputDuration('8');
    expect(full(e)).toBe(true);
  });

  it('和音と調号', () => {
    const e = new Editor(createScore({ keyFifths: 1 }));
    e.inputDiatonic(31); // F4 → ト長調なので F#
    const n = e.selected!;
    expect(n.kind === 'note' && n.pitches[0].alter).toBe(1);
    e.toggleChordMode();
    e.inputDiatonic(33);
    expect(e.selected!.kind === 'note' && e.selected!.pitches.length).toBe(2);
  });

  it('拍子を変えると並べ直す', () => {
    const s = createScore();
    const e = new Editor(s);
    for (let i = 0; i < 4; i++) e.inputDiatonic(28 + i);
    e.setTimeSignature({ beats: 3, beatType: 4 });
    expect(full(e)).toBe(true);
    const notes = e.score.parts[0].measures.flatMap((m) => m.events).filter((x) => x.kind === 'note');
    expect(notes.length).toBe(4);
  });

  it('reflow は空のパートでも1小節を残す', () => {
    const s = createScore();
    s.parts[0].measures = [];
    reflowPart(s.parts[0], measureCapacity(s.timeSignature));
    expect(s.parts[0].measures.length).toBe(1);
  });
});
