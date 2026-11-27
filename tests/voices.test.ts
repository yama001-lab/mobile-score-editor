// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor/editor';
import { createScore, measureCapacity, measureTicks, reflowPart, voiceEvents } from '../src/model/score';
import { migrate } from '../src/storage/local';
import { buildSchedule } from '../src/audio/schedule';
import { toMusicXml } from '../src/export/musicxml';
import { parseMusicXml } from '../src/import/musicxml';
import { renderScore } from '../src/render/render';

const C4 = 28;
const full = (e: Editor) => e.score.parts.every((p) => p.measures.every((m) =>
  measureTicks(m) === e.capacity && (!m.voice2 || m.voice2.reduce((s, x) => s + (x.duration === 'q' ? 480 : 0), 0) >= 0)));

function twoVoices() {
  const e = new Editor(createScore());
  e.setInputDuration('h');
  e.inputDiatonic(C4 + 4); // G4 2分
  e.inputDiatonic(C4 + 5); // A4 2分
  e.setCursor({ partIndex: 0, measureIndex: 0, eventIndex: 0 });
  e.setVoice(1);
  e.setInputDuration('q');
  e.inputDiatonic(C4); // 声部2：C4 4分×2
  e.inputDiatonic(C4 + 2);
  return e;
}

describe('1段2声部', () => {
  it('古い保存データ（voice2なし）はそのまま読める', () => {
    const old = JSON.parse(JSON.stringify(createScore()));
    const s = migrate(old);
    expect(s.parts[0].measures[0].voice2).toBeUndefined();
    expect(voiceEvents(s.parts[0].measures[0], 1)).toEqual([]);
  });

  it('声部2に入れても声部1は変わらず、両方の声部が小節を埋める', () => {
    const e = twoVoices();
    const m = e.score.parts[0].measures[0];
    expect(m.events.map((x) => x.kind)).toEqual(['note', 'note']);
    expect(m.voice2!.map((x) => x.kind)).toEqual(['note', 'note', 'rest']);
    expect(m.voice2!.reduce((s, x) => s + (x.duration === 'q' ? 480 : 960), 0)).toBe(e.capacity);
    expect(e.cursor).toEqual({ partIndex: 0, measureIndex: 0, eventIndex: 2, voice: 1 });
    expect(full(e)).toBe(true);
  });

  it('拍の途中から声部2を入れられる（休符を分ける）', () => {
    const e = new Editor(createScore());
    e.inputDiatonic(C4); e.inputDiatonic(C4); e.inputDiatonic(C4); e.inputDiatonic(C4);
    e.setCursorAtTick(0, 0, 1, 960);
    e.inputDiatonic(C4 - 3);
    const v2 = e.score.parts[0].measures[0].voice2!;
    expect(v2.map((x) => `${x.kind}:${x.duration}`)).toEqual(['rest:h', 'note:q', 'rest:q']);
  });

  it('声部2を消して休符だけになったら声部2はなくなる', () => {
    const e = twoVoices();
    const v2 = e.score.parts[0].measures[0].voice2!;
    e.eraseEvents(v2.filter((x) => x.kind === 'note').map((x) => x.id));
    expect(e.score.parts[0].measures[0].voice2).toBeUndefined();
    expect(e.score.parts[0].measures[0].events.length).toBe(2);
  });

  it('元に戻すで声部2の入力も戻る', () => {
    const e = twoVoices();
    e.undo(); e.undo();
    const v2 = e.score.parts[0].measures[0].voice2;
    expect(!v2 || v2.every((x) => x.kind === 'rest')).toBe(true);
  });

  it('声部2の音を選ぶと入力も声部2になり、選んだ音を動かせる', () => {
    const e = twoVoices();
    const id = e.score.parts[0].measures[0].voice2![0].id;
    e.setCursor({ partIndex: 0, measureIndex: 0, eventIndex: 0 });
    expect(e.voice).toBe(0);
    e.select(id);
    expect(e.voice).toBe(1);
    e.transposeSelected(1);
    expect(e.score.parts[0].measures[0].voice2![0].kind === 'note' && e.score.parts[0].measures[0].voice2![0].pitches[0].step).toBe('D');
  });

  it('再生は両方の声部を鳴らす', () => {
    const e = twoVoices();
    const midis = buildSchedule(e.score).notes.map((n) => n.midi).sort();
    expect(midis).toEqual([60, 64, 67, 69]);
  });

  it('拍子を変えても声部2が流し直される', () => {
    const e = twoVoices();
    const part = e.score.parts[0];
    reflowPart(part, measureCapacity({ beats: 2, beatType: 4 }));
    expect(part.measures[0].voice2!.map((x) => x.kind)).toEqual(['note', 'note']);
    expect(part.measures[1].voice2).toBeUndefined();
  });

  it('MusicXML に書き出して取り込むと2声部が戻る', () => {
    const e = twoVoices();
    const xml = toMusicXml(e.score);
    expect(xml).toContain('<backup>');
    expect(xml).toContain('<voice>2</voice>');
    const { score, warnings } = parseMusicXml(xml);
    const m = score.parts[0].measures[0];
    expect(m.events.filter((x) => x.kind === 'note').length).toBe(2);
    expect(m.voice2!.filter((x) => x.kind === 'note').length).toBe(2);
    expect(warnings.join()).not.toContain('声部');
  });

  it('描画で声部2の当たり判定ができ、符尾が下を向く', () => {
    const e = twoVoices();
    // jsdom には文字の大きさを測る機能がないので、仮の値を返す
    (window.SVGElement.prototype as unknown as { getBBox: () => object }).getBBox = () => ({ x: 0, y: 0, width: 10, height: 10 });
    const el = document.createElement('div');
    document.body.appendChild(el);
    const res = renderScore(el, e.score, { width: 800 });
    const h = res.hits.find((x) => x.measureIndex === 0)!;
    expect(h.voices[0].length).toBe(2);
    expect(h.voices[1].length).toBe(3);
    expect(h.voices[1][1].tick).toBe(480);
  });
});
