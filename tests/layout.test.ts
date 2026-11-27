// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { Editor } from '../src/editor/editor';
import { toMusicXml } from '../src/export/musicxml';
import { parseMusicXml } from '../src/import/musicxml';
import { createScore, measureAttrsAt } from '../src/model/score';
import { breakSystems, layoutSystems, paginate, renderScore } from '../src/render/render';

beforeAll(() => {
  // jsdom には文字の大きさを測る機能がないので仮の値を返す
  (window.SVGElement.prototype as unknown as { getBBox: () => object }).getBBox = () => ({ x: 0, y: 0, width: 40, height: 12 });
});

function editorWith(n: number) {
  const e = new Editor(createScore());
  while (e.score.parts[0].measures.length < n) e.addMeasure();
  e.score.parts[0].measures = e.score.parts[0].measures.slice(0, n);
  return e;
}
const groups = (e: Editor, width = 800) => layoutSystems(e.score, { width }).map((s) => s.measures);

describe('改行・改ページ', () => {
  it('改行を入れた小節のあとで段が変わる', () => {
    const e = editorWith(6);
    e.setBreak(1, { system: true });
    const g = groups(e, 2000);
    expect(g[0]).toEqual([0, 1]);
    expect(g[1][0]).toBe(2);
  });

  it('切り替えで付け外しでき、元に戻せる', () => {
    const e = editorWith(4);
    e.toggleSystemBreak(2);
    expect(measureAttrsAt(e.score, 2)?.systemBreak).toBe(true);
    e.toggleSystemBreak(2);
    expect(measureAttrsAt(e.score, 2)).toBeUndefined();
    e.undo();
    expect(measureAttrsAt(e.score, 2)?.systemBreak).toBe(true);
  });

  it('改ページは改行も兼ね、PDFのページを分ける', () => {
    const e = editorWith(6);
    e.setBreak(2, { system: true });
    e.setBreak(2, { page: true });
    const a = measureAttrsAt(e.score, 2)!;
    expect(a.pageBreak).toBe(true);
    expect(a.systemBreak).toBeUndefined();
    const systems = layoutSystems(e.score, { width: 2000 });
    expect(systems.map((s) => s.measures)).toEqual([[0, 1, 2], [3, 4, 5]]);
    const pages = paginate(e.score, systems, 1123, 40);
    expect(pages.map((p) => p.systems.map((s) => s.measures[0]))).toEqual([[0], [3]]);
    expect(pages[1].first).toBe(false);
  });

  it('最後の小節の改ページで空のページはできない', () => {
    const e = editorWith(3);
    e.setBreak(2, { page: true });
    expect(paginate(e.score, layoutSystems(e.score, { width: 800 }), 1123, 40)).toHaveLength(1);
  });

  it('小節を挿入・削除すると改行の位置もずれる', () => {
    const e = editorWith(5);
    e.setBreak(2, { system: true });
    e.addMeasure(0);
    expect(measureAttrsAt(e.score, 3)?.systemBreak).toBe(true);
    e.removeMeasure(3);
    expect(e.score.measureAttrs).toBeUndefined();
  });

  it('MusicXML の print で書き出し・読み込みできる', () => {
    const e = editorWith(4);
    e.setBreak(0, { system: true });
    e.setBreak(2, { page: true });
    const xml = toMusicXml(e.score);
    expect(xml).toContain('<print new-system="yes"/>');
    expect(xml).toContain('<print new-page="yes"/>');
    const { score: back } = parseMusicXml(xml);
    expect(measureAttrsAt(back, 0)?.systemBreak).toBe(true);
    expect(measureAttrsAt(back, 2)?.pageBreak).toBe(true);
  });
});

describe('1段の小節数', () => {
  it('指定した数ずつ並べ、改行の指定が優先される', () => {
    const e = editorWith(10);
    e.setMeasuresPerSystem(4);
    expect(groups(e).map((g) => g.length)).toEqual([4, 4, 2]);
    e.setBreak(1, { system: true });
    expect(groups(e)).toEqual([[0, 1], [2, 3, 4, 5], [6, 7, 8, 9]]);
  });

  it('狭い幅でも指定どおりに並べ、幅に収める', () => {
    const e = editorWith(8);
    e.setMeasuresPerSystem(8);
    const systems = layoutSystems(e.score, { width: 400 });
    expect(systems).toHaveLength(1);
    const total = systems[0].widths.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(400 - 48 + 0.01);
  });

  it('最後の段は小節の幅を上の段とそろえる', () => {
    const e = editorWith(6);
    e.setMeasuresPerSystem(4);
    const [a, b] = layoutSystems(e.score, { width: 800 });
    const sum = (w: number[]) => w.reduce((x, y) => x + y, 0);
    expect(sum(b.widths)).toBeLessThan(sum(a.widths) * 0.7);
    expect(sum(b.widths)).toBeGreaterThan(sum(a.widths) * 0.4);
    // 最後の段がちょうど指定の数なら、上の段と同じ幅まで広げる
    e.setMeasuresPerSystem(3);
    const ws = layoutSystems(e.score, { width: 800 }).map((x) => sum(x.widths));
    expect(ws[1]).toBeCloseTo(ws[0], 3);
  });

  it('自動に戻すと設定が消える', () => {
    const e = editorWith(2);
    e.setMeasuresPerSystem(3);
    expect(e.score.layout?.measuresPerSystem).toBe(3);
    e.setMeasuresPerSystem(null);
    expect(e.score.layout).toBeUndefined();
  });

  it('breakSystems は幅の判定を受け取り、指定がなければそれで改行する', () => {
    const s = createScore();
    s.parts[0].measures = s.parts[0].measures.slice(0, 5);
    expect(breakSystems(s, (ms) => ms.length < 2).map((g) => g.measures)).toEqual([[0, 1], [2, 3], [4]]);
  });
});

describe('画面の目印', () => {
  it('showBreaks のときだけ改行の目印を描く', () => {
    const e = editorWith(4);
    e.setBreak(1, { system: true });
    const a = document.createElement('div');
    const b = document.createElement('div');
    renderScore(a, e.score, { width: 800 });
    renderScore(b, e.score, { width: 800, showBreaks: true });
    expect(b.innerHTML).toContain('#1565c0');
    expect(a.innerHTML).not.toContain('#1565c0');
  });
});
