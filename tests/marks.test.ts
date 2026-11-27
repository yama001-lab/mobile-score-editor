// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor/editor';
import { createScore, reflowPart, measureCapacity } from '../src/model/score';
import { resolveSpanners } from '../src/model/marks';
import { buildSchedule } from '../src/audio/schedule';
import { toMusicXml } from '../src/export/musicxml';
import { parseMusicXml } from '../src/import/musicxml';
import { renderScore } from '../src/render/render';

/** C D E F を4分音符で入れた楽譜 */
function fourNotes(tempo = 60) {
  const e = new Editor(createScore({ tempo }));
  e.setMode('input');
  for (const m of [60, 62, 64, 65]) e.inputMidi(m);
  return e;
}
const ids = (e: Editor) => e.score.parts[0].measures[0].events.map((x) => x.id);

describe('スラー・ヘアピン', () => {
  it('選択モード：選んだ音から次の音へ。続けて押すと伸び、始まりで押すと消える', () => {
    const e = fourNotes();
    e.setMode('select');
    const [a, b, c] = ids(e);
    e.select(a);
    e.toggleSpanner('slur');
    expect(e.score.spanners).toMatchObject([{ kind: 'slur', from: a, to: b }]);
    expect(e.selectedId).toBe(b);
    e.toggleSpanner('slur');
    expect(e.score.spanners).toMatchObject([{ kind: 'slur', from: a, to: c }]);
    e.select(a);
    e.toggleSpanner('slur');
    expect(e.score.spanners ?? []).toHaveLength(0);
  });

  it('入力モード：直前の音からつなぎ、入れながら押すと伸びる', () => {
    const e = new Editor(createScore());
    e.setMode('input');
    e.inputMidi(60);
    e.inputMidi(62);
    e.toggleSpanner('slur');
    e.inputMidi(64);
    e.toggleSpanner('slur');
    const [a, , c] = ids(e);
    expect(e.score.spanners).toMatchObject([{ kind: 'slur', from: a, to: c }]);
  });

  it('クレッシェンドとディミヌエンドは重ならない', () => {
    const e = fourNotes();
    e.setMode('select');
    const [a, b, c] = ids(e);
    e.select(a);
    e.toggleSpanner('cresc');
    e.toggleSpanner('cresc'); // a→c
    e.select(b);
    e.toggleSpanner('dim'); // b→c が a→c と重なる
    const r = resolveSpanners(e.score);
    expect(r.map((x) => [x.spanner.kind, x.spanner.from, x.spanner.to])).toEqual([['dim', b, c]]);
  });

  it('音符が消えたスパナーは無視する', () => {
    const e = fourNotes();
    e.setMode('select');
    const [a] = ids(e);
    e.select(a);
    e.toggleSpanner('slur');
    e.select(ids(e)[1]);
    e.deleteSelected();
    expect(resolveSpanners(e.score)).toHaveLength(0);
  });

  it('拍子を変えても記号が残る', () => {
    const e = fourNotes();
    e.setMode('select');
    const [a] = ids(e);
    e.select(a);
    e.toggleArticulation('staccato');
    e.toggleSpanner('slur');
    reflowPart(e.score.parts[0], measureCapacity({ beats: 3, beatType: 4 }));
    expect(resolveSpanners(e.score)).toHaveLength(1);
    expect(e.score.parts[0].measures[0].events[0].articulations).toEqual(['staccato']);
  });
});

describe('アーティキュレーション・強弱', () => {
  it('付け外しできる。アクセントとマルカートは片方だけ。休符にはフェルマータだけ', () => {
    const e = fourNotes();
    e.setMode('select');
    e.select(ids(e)[0]);
    e.toggleArticulation('accent');
    e.toggleArticulation('staccato');
    e.toggleArticulation('marcato');
    expect(e.selected?.articulations).toEqual(['staccato', 'marcato']);
    e.toggleArticulation('staccato');
    expect(e.selected?.articulations).toEqual(['marcato']);
    e.setDynamic('p');
    expect(e.selected?.dynamic).toBe('p');
    e.setDynamic('p');
    expect(e.selected?.dynamic).toBeUndefined();
    e.select(e.score.parts[0].measures[1].events[0].id);
    e.toggleArticulation('staccato');
    e.toggleArticulation('fermata');
    expect(e.selected?.articulations).toEqual(['fermata']);
  });
});

describe('再生', () => {
  it('強弱記号とアクセントで強さ、スタッカートで長さが変わる', () => {
    const e = fourNotes(60);
    e.setMode('select');
    const [a, b, c] = ids(e);
    e.select(a); e.setDynamic('p');
    e.select(b); e.toggleArticulation('accent');
    e.select(c); e.toggleArticulation('staccato'); e.setDynamic('f');
    const n = buildSchedule(e.score).notes;
    expect(n[0].velocity).toBeCloseTo(0.45);
    expect(n[1].velocity).toBeCloseTo(0.45 * 1.25);
    expect(n[2].velocity).toBeCloseTo(0.95);
    expect(n[2].duration).toBeCloseTo(0.5);
  });

  it('クレッシェンドはだんだん強く、次の強弱記号に向かう', () => {
    const e = fourNotes(60);
    e.setMode('select');
    const [a, , , d] = ids(e);
    e.select(a); e.setDynamic('p');
    e.toggleSpanner('cresc'); e.toggleSpanner('cresc'); // a→c
    e.select(d); e.setDynamic('f');
    const v = buildSchedule(e.score).notes.map((x) => x.velocity!);
    expect(v[0]).toBeLessThan(v[1]);
    expect(v[1]).toBeLessThan(v[2]);
    expect(v[3]).toBeCloseTo(0.95);
  });

  it('フェルマータの音は倍の長さになり、後ろがずれる', () => {
    const e = fourNotes(60);
    e.setMode('select');
    e.select(ids(e)[1]);
    e.toggleArticulation('fermata');
    const n = buildSchedule(e.score).notes;
    expect(n[1].duration).toBeCloseTo(2);
    expect(n[2].time).toBeCloseTo(3);
  });
});

describe('MusicXML', () => {
  it('書き出して取り込むと記号が戻る', () => {
    const e = fourNotes();
    e.setMode('select');
    const [a, b, c, d] = ids(e);
    e.select(a); e.setDynamic('mp'); e.toggleArticulation('tenuto');
    e.toggleSpanner('slur'); e.toggleSpanner('slur'); // a→c
    e.select(b); e.toggleSpanner('cresc'); e.toggleSpanner('cresc'); // b→d
    e.select(d); e.toggleArticulation('fermata'); e.toggleArticulation('accent');
    void c;
    const xml = toMusicXml(e.score);
    expect(xml).toContain('<slur type="start" number="1"/>');
    expect(xml).toContain('<wedge type="crescendo" number="1"/>');
    expect(xml).toContain('<dynamics><mp/></dynamics>');
    const back = parseMusicXml(xml).score;
    const ev = back.parts[0].measures[0].events;
    expect(ev[0].dynamic).toBe('mp');
    expect(ev[0].articulations).toEqual(['tenuto']);
    expect(ev[3].articulations?.sort()).toEqual(['accent', 'fermata']);
    const sp = resolveSpanners(back).map((r) => [r.spanner.kind, r.from.index, r.to.index]);
    expect(sp).toEqual([['slur', 0, 2], ['cresc', 1, 3]]);
  });
});

describe('描画', () => {
  it('記号が付いた楽譜を描ける（段をまたぐスラーも）', () => {
    const e = new Editor(createScore());
    e.setMode('input');
    for (let i = 0; i < 24; i++) e.inputMidi(60 + (i % 12));
    e.setMode('select');
    const first = e.score.parts[0].measures[0].events[0].id;
    e.select(first);
    e.setDynamic('pp');
    e.toggleArticulation('staccato');
    for (let i = 0; i < 20; i++) e.toggleSpanner('slur');
    e.select(first);
    for (let i = 0; i < 6; i++) e.toggleSpanner('cresc');
    // jsdom には文字の大きさを測る機能がないので仮の値を返す
    (window.SVGElement.prototype as unknown as { getBBox: () => object }).getBBox = () => ({ x: 0, y: 0, width: 40, height: 12 });
    const el = document.createElement('div');
    renderScore(el, e.score, { width: 500 });
    expect(el.querySelectorAll('path').length).toBeGreaterThan(50);
  });
});
