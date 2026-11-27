// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildSchedule } from '../src/audio/schedule';
import { Editor } from '../src/editor/editor';
import { toMusicXml } from '../src/export/musicxml';
import { parseMusicXml } from '../src/import/musicxml';
import { createScore, eventTicks, measureTicks, MusicEvent } from '../src/model/score';

const full = (e: Editor) => e.score.parts.every((p) => p.measures.every((m) => measureTicks(m) === e.capacity));
const m0 = (e: Editor) => e.score.parts[0].measures[0].events;
const shape = (evs: MusicEvent[]) => evs.map((ev) => `${ev.kind === 'note' ? ev.pitches[0].step : 'r'}${ev.duration}${ev.tuplet ? '/' + ev.tuplet.actual : ''}`);

describe('連符', () => {
  it('入力モード：4分の長さの3連符を作り、続けて3つ入れると連符が埋まって次へ進む', () => {
    const e = new Editor(createScore({ tempo: 60 }));
    e.setInputDuration('q');
    expect(e.createTuplet(3)).toBeNull();
    expect(e.inputDuration).toBe('8');
    expect(full(e)).toBe(true);
    e.inputMidi(60);
    e.inputMidi(62);
    e.inputMidi(64);
    expect(shape(m0(e)).slice(0, 4)).toEqual(['C8/3', 'D8/3', 'E8/3', 'rh']);
    expect(m0(e).slice(0, 3).map(eventTicks)).toEqual([160, 160, 160]);
    expect(full(e)).toBe(true);
    // 連符の後は普通の音符に戻る
    e.setInputDuration('q');
    e.inputMidi(65);
    expect(shape(m0(e))[3]).toBe('Fq');
    expect(full(e)).toBe(true);
  });

  it('連符の中では長い音価も連符の中に収める（4分＋8分の3連符）', () => {
    const e = new Editor(createScore());
    e.setInputDuration('q');
    e.createTuplet(3);
    e.setInputDuration('q');
    e.inputMidi(60);
    e.setInputDuration('8');
    e.inputMidi(62);
    expect(shape(m0(e)).slice(0, 2)).toEqual(['Cq/3', 'D8/3']);
    expect(eventTicks(m0(e)[0]) + eventTicks(m0(e)[1])).toBe(480);
    // 残りより長い音は、残りに収まる長さに縮める
    e.setCursor({ partIndex: 0, measureIndex: 0, eventIndex: 1 });
    e.setInputDuration('h');
    e.inputMidi(64);
    expect(shape(m0(e)).slice(0, 3)).toEqual(['Cq/3', 'E8/3', 'rh']);
    expect(full(e)).toBe(true);
  });

  it('選択モード：選んだ音符を3連符にすると、その高さが連符の頭になる', () => {
    const e = new Editor(createScore());
    e.setInputDuration('h');
    e.inputMidi(67);
    const id = m0(e)[0].id;
    e.setMode('select');
    e.select(id);
    expect(e.createTuplet(3)).toBeNull();
    expect(shape(m0(e))).toEqual(['Gq/3', 'rq/3', 'rq/3', 'rh']);
    expect(e.inTuplet).toBe(true);
    // 連符の中で長さを変えても連符の長さは変わらない
    e.select(m0(e)[0].id);
    e.setSelectedDuration('8', 0);
    expect(shape(m0(e))).toEqual(['G8/3', 'r8/3', 'rq/3', 'rq/3', 'rh']);
    expect(full(e)).toBe(true);
    e.removeTuplet();
    expect(m0(e).some((ev) => ev.tuplet)).toBe(false);
    expect(full(e)).toBe(true);
  });

  it('5連符・6連符、付点4分の2連符を作れる。作れない長さは理由を返す', () => {
    const e = new Editor(createScore());
    e.setInputDuration('q');
    expect(e.createTuplet(5)).toBeNull();
    expect(m0(e).filter((ev) => ev.tuplet).map(eventTicks)).toEqual([96, 96, 96, 96, 96]);
    const e2 = new Editor(createScore({ timeSignature: { beats: 6, beatType: 8 } }));
    e2.setInputDuration('q');
    expect(e2.createTuplet(2)).toMatch(/付点/);
    e2.inputDots = 1;
    expect(e2.createTuplet(2)).toBeNull();
    expect(shape(m0(e2)).slice(0, 2)).toEqual(['r8/2', 'r8/2']);
    expect(m0(e2).slice(0, 2).map(eventTicks)).toEqual([360, 360]);
    expect(full(e2)).toBe(true);
    const e3 = new Editor(createScore({ timeSignature: { beats: 2, beatType: 4 } }));
    e3.setInputDuration('w');
    expect(e3.createTuplet(3)).toMatch(/収まりません/);
  });

  it('連符にかかる普通の音を入れると、その連符はまるごと消える', () => {
    const e = new Editor(createScore());
    e.setInputDuration('q');
    e.createTuplet(3);
    e.setCursor({ partIndex: 0, measureIndex: 0, eventIndex: 0 });
    e.select(null);
    // カーソルは連符の頭なので連符の中に入る。連符を外した後に2分音符を入れる
    e.removeTuplet();
    e.setInputDuration('h');
    e.inputMidi(60);
    expect(m0(e).some((ev) => ev.tuplet)).toBe(false);
    expect(full(e)).toBe(true);
  });

  it('再生では連符の長さで鳴る', () => {
    const e = new Editor(createScore({ tempo: 60 }));
    e.setInputDuration('q');
    e.createTuplet(3);
    e.inputMidi(60);
    e.inputMidi(62);
    e.inputMidi(64);
    const s = buildSchedule(e.score);
    expect(s.notes.map((n) => +n.time.toFixed(4))).toEqual([0, 0.3333, 0.6667]);
  });

  it('拍子を変えても連符は崩れない（小節線をまたぐなら次の小節へ送る）', () => {
    const e = new Editor(createScore());
    e.setInputDuration('h');
    e.inputMidi(60);
    e.setInputDuration('q');
    e.inputMidi(62);
    e.createTuplet(3);
    e.setTimeSignature({ beats: 3, beatType: 4 });
    expect(full(e)).toBe(true);
    const all = e.score.parts[0].measures.flatMap((m) => m.events);
    expect(all.filter((ev) => ev.tuplet)).toHaveLength(3);
    const m1 = e.score.parts[0].measures[1].events;
    expect(m1.filter((ev) => ev.tuplet)).toHaveLength(3);
  });

  it('MusicXML に書き出して読み戻すと連符が残る', () => {
    const e = new Editor(createScore());
    e.setInputDuration('q');
    e.createTuplet(3);
    e.inputMidi(60);
    e.inputMidi(62);
    e.inputMidi(64);
    const xml = toMusicXml(e.score);
    expect(xml).toContain('<actual-notes>3</actual-notes><normal-notes>2</normal-notes>');
    expect(xml).toContain('<tuplet type="start" bracket="yes"/>');
    expect(xml).toContain('<tuplet type="stop"/>');
    const { score, warnings } = parseMusicXml(xml);
    const evs = score.parts[0].measures[0].events;
    expect(shape(evs).slice(0, 3)).toEqual(['C8/3', 'D8/3', 'E8/3']);
    expect(new Set(evs.slice(0, 3).map((ev) => ev.tuplet!.id)).size).toBe(1);
    expect(warnings.some((w) => w.includes('連符'))).toBe(false);
  });
});
