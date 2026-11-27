import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor/editor';
import { createScore, measureTicks, MusicEvent } from '../src/model/score';
import { rangeEventIds } from '../src/editor/range';

const full = (e: Editor) => e.score.parts.every((p) => p.measures.every((m) => measureTicks(m) === e.capacity));
const names = (evs: MusicEvent[]) =>
  evs.map((ev) => (ev.kind === 'rest' ? `r${ev.duration}` : ev.pitches.map((p) => p.step + p.octave).join('+') + ev.duration + (ev.tie ? '~' : '')));
const measure = (e: Editor, mi: number, p = 0) => names(e.score.parts[p].measures[mi].events);

/** 1小節目に C D E F（4分）を入れた楽譜 */
function cdef(grand = false) {
  const e = new Editor(createScore({ grandStaff: grand }));
  for (const m of [60, 62, 64, 65]) e.inputMidi(m);
  e.setMode('select');
  return e;
}
const idAt = (e: Editor, mi: number, ei: number, p = 0) => e.score.parts[p].measures[mi].events[ei].id;

describe('範囲選択', () => {
  it('Shift+タップのように、選んだ音から別の音までを範囲にする', () => {
    const e = cdef();
    e.select(idAt(e, 0, 1));
    e.extendSelectionTo(idAt(e, 0, 3));
    expect(e.range).toMatchObject({ partFrom: 0, partTo: 0, start: 480, end: 1920 });
    expect(e.rangeIds!.size).toBe(3);
    // 起点より前へ広げ直す
    e.extendSelectionTo(idAt(e, 0, 0));
    expect(e.range).toMatchObject({ start: 0, end: 960 });
  });

  it('Shift+→で1つずつ広げる。ふつうに選び直すと範囲は解ける', () => {
    const e = cdef();
    e.select(idAt(e, 0, 0));
    e.extendByStep(1);
    e.extendByStep(1);
    expect(e.range).toMatchObject({ start: 0, end: 1440 });
    e.select(idAt(e, 0, 3));
    expect(e.range).toBeNull();
  });

  it('大譜表で上下のパートにまたがる範囲は、区切りの違う音も含める', () => {
    const e = cdef(true);
    e.selectRange(idAt(e, 0, 1), idAt(e, 0, 0, 1));
    // 下のパートは全休符1つなので、範囲は小節全体になる
    expect(e.range).toMatchObject({ partFrom: 0, partTo: 1, start: 0, end: 1920 });
    expect(rangeEventIds(e.score, e.range!).size).toBe(5);
  });
});

describe('コピー・貼り付け', () => {
  it('範囲をコピーして別の小節に貼る。貼った所が選ばれ、小節は埋まったまま', () => {
    const e = cdef();
    e.selectRange(idAt(e, 0, 0), idAt(e, 0, 1));
    expect(e.copy()).toBe(true);
    e.select(idAt(e, 1, 0));
    e.paste();
    expect(measure(e, 1)).toEqual(['C4q', 'D4q', 'rh']);
    expect(e.range).toMatchObject({ start: 1920, end: 2880 });
    expect(full(e)).toBe(true);
    // 元の小節は変わらない
    expect(measure(e, 0)).toEqual(['C4q', 'D4q', 'E4q', 'F4q']);
  });

  it('小節線をまたいで貼ると、またいだ音をタイで分ける', () => {
    const e = cdef();
    e.selectRange(idAt(e, 0, 0), idAt(e, 0, 1));
    e.copy();
    e.select(idAt(e, 0, 3)); // F の位置（3拍目の後ろ）から貼る
    e.paste();
    expect(measure(e, 0)).toEqual(['C4q', 'D4q', 'E4q', 'C4q']);
    expect(measure(e, 1)[0]).toBe('D4q');
    expect(full(e)).toBe(true);
  });

  it('範囲の途中にかかる長い音は、端で分けてタイでつなぐ', () => {
    const e = new Editor(createScore());
    e.setInputDuration('h');
    e.inputMidi(67); // 2分音符
    e.setInputDuration('q');
    e.inputMidi(69);
    e.inputMidi(71);
    e.setMode('select');
    // 2拍目〜3拍目：G の後半と A
    e.setRange({ partFrom: 0, partTo: 0, start: 480, end: 1440 });
    e.copy();
    expect(names(e.clipboard!.parts[0])).toEqual(['G4q', 'A4q']);
    // 元の楽譜は分けていない
    expect(measure(e, 0)).toEqual(['G4h', 'A4q', 'B4q']);
  });

  it('最後の小節より後ろに貼ると小節が増える', () => {
    const e = cdef();
    e.selectMeasures(0, 0, 0, 0);
    e.copy();
    const n = e.score.parts[0].measures.length;
    e.setRange({ partFrom: 0, partTo: 0, start: (n - 1) * e.capacity, end: n * e.capacity });
    e.paste();
    e.select(idAt(e, n - 1, 0));
    e.paste();
    expect(e.score.parts[0].measures.length).toBe(n);
    expect(measure(e, n - 1)).toEqual(['C4q', 'D4q', 'E4q', 'F4q']);
    // 途中から貼ると、はみ出した分の小節が足される
    e.select(idAt(e, n - 1, 2));
    e.paste();
    expect(e.score.parts[0].measures.length).toBe(n + 1);
    expect(full(e)).toBe(true);
  });

  it('切り取ると休符になり、元に戻すで戻る', () => {
    const e = cdef();
    e.selectRange(idAt(e, 0, 1), idAt(e, 0, 2));
    e.cut();
    expect(measure(e, 0)).toEqual(['C4q', 'rq', 'rq', 'F4q']);
    e.undo();
    expect(measure(e, 0)).toEqual(['C4q', 'D4q', 'E4q', 'F4q']);
    expect(e.range).toBeNull();
  });

  it('小節全体を削除すると全休符1つになる', () => {
    const e = cdef();
    e.selectMeasures(0, 0, 0, 0);
    e.deleteSelected();
    expect(measure(e, 0)).toEqual(['rw']);
  });

  it('範囲を選ばずに1音だけコピーして、入力位置に貼る', () => {
    const e = cdef();
    e.select(idAt(e, 0, 2)); // E
    e.copy();
    e.setMode('input');
    e.setCursor({ partIndex: 0, measureIndex: 1, eventIndex: 0 });
    e.paste();
    expect(measure(e, 1)).toEqual(['E4q', 'rh']); // 残りは付点2分休符
    // 続けて貼ると後ろに並ぶ
    e.paste();
    expect(measure(e, 1)).toEqual(['E4q', 'E4q', 'rh']);
  });

  it('大譜表の2パートをまとめて貼る', () => {
    const e = new Editor(createScore({ grandStaff: true }));
    e.inputMidi(60);
    e.setCursor({ partIndex: 1, measureIndex: 0, eventIndex: 0 });
    e.inputMidi(48);
    e.setMode('select');
    e.selectMeasures(0, 1, 0, 0);
    e.copy();
    e.select(idAt(e, 2, 0));
    e.paste();
    expect(measure(e, 2, 0)[0]).toBe('C4q');
    expect(measure(e, 2, 1)[0]).toBe('C3q');
    expect(full(e)).toBe(true);
  });

  it('範囲の音をまとめて上下に動かす・臨時記号を付ける', () => {
    const e = cdef();
    e.selectRange(idAt(e, 0, 0), idAt(e, 0, 1));
    e.transposeSelected(1);
    expect(measure(e, 0)).toEqual(['D4q', 'E4q', 'E4q', 'F4q']);
    expect(e.range).not.toBeNull();
    e.setSelectedAccidental(1);
    const ev = e.score.parts[0].measures[0].events[0];
    expect(ev.kind === 'note' && ev.pitches[0].alter).toBe(1);
  });

  it('タイの途中で範囲が切れても、前の音のタイは残らない', () => {
    const e = new Editor(createScore());
    e.inputMidi(60);
    e.toggleTie(); // C〜C
    e.setMode('select');
    // 2拍目（タイの行き先）を休符にする
    e.select(idAt(e, 0, 1));
    e.deleteSelected();
    expect(measure(e, 0)[0]).toBe('C4q');
  });
});
