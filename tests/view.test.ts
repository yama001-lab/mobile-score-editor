// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { addSpanner } from '../src/model/marks';
import { NoteEvent, Score, createScore, makeNote } from '../src/model/score';
import { RenderOptions, RenderResult, renderScore } from '../src/render/render';
import { ScoreView } from '../src/render/view';

// jsdom には SVG の大きさを測る getBBox がないので、文字数で見積もる
(SVGElement.prototype as unknown as { getBBox(): unknown }).getBBox = function (this: SVGElement) {
  return { x: 0, y: 0, width: (this.textContent?.length ?? 0) * 7, height: 12 };
};

const P = (step: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B', octave: number) => ({ step, alter: 0, octave });

/** 大譜表で8分音符を詰めた長い曲。段をまたぐタイ・スラー・歌詞のハイフンも入れる */
function longScore(bars: number): Score {
  const s = createScore({ grandStaff: true });
  const steps = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
  for (let i = s.parts[0].measures.length; i < bars; i++) {
    for (const p of s.parts) p.measures.push({ ...structuredClone(p.measures[0]), id: `m${p.id}${i}` });
  }
  s.parts.forEach((p, pi) => p.measures.forEach((m, mi) => {
    m.id = `m${pi}-${mi}`;
    m.events = Array.from({ length: 8 }, (_, k) => {
      const n = makeNote([P(steps[(mi + k) % 7], pi ? 3 : 5)], '8');
      n.id = `e${pi}-${mi}-${k}`;
      return n;
    });
    delete m.voice2;
  }));
  // すべての小節の最後の音を次の小節の頭とタイでつなぐ（同じ高さにする）
  s.parts[0].measures.forEach((m, mi) => {
    const next = s.parts[0].measures[mi + 1];
    if (!next || mi % 3) return;
    const last = m.events[7] as NoteEvent;
    last.pitches = [...(next.events[0] as NoteEvent).pitches];
    last.tie = true;
  });
  // 段をまたぐ長いスラーと、ハイフンでつながる歌詞
  addSpanner(s, 'slur', 'e0-2-0', 'e0-14-3');
  s.parts[0].measures.forEach((m) => m.events.forEach((e, k) => { (e as NoteEvent).lyrics = [k % 2 ? 'ら' : 'さ-']; }));
  return s;
}

const opts: RenderOptions = { width: 900, drawTitle: true };

function round(r: RenderResult) {
  const f = (v: number) => Math.round(v * 10) / 10;
  return {
    hits: r.hits.map((h) => ({
      p: h.partIndex, m: h.measureIndex, x0: f(h.x0), x1: f(h.x1), top: f(h.topLineY),
      voices: h.voices.map((l) => l.map((e) => [e.id, f(e.x), f(e.left), f(e.right), ...e.headYs.map(f)])),
    })),
    tempo: r.tempoHits.map((t) => [t.measure, f(t.x), f(t.y)]),
    texts: r.textHits.map((t) => [t.kind, t.eventId ?? t.measureIndex, f(t.x), f(t.y)]),
    height: r.height,
  };
}

/** SVG の要素の種類ごとの数（全体を描いたときと段ごとに描いたときで同じになるはず） */
function counts(el: HTMLElement) {
  const out: Record<string, number> = {};
  el.querySelectorAll('svg *').forEach((n) => { out[n.tagName] = (out[n.tagName] ?? 0) + 1; });
  return out;
}

function full(s: Score, o: RenderOptions) {
  const el = document.createElement('div');
  const res = renderScore(el, s, o);
  return { res, el };
}

describe('段ごとの描き直し', () => {
  it('段ごとに描いても、全体を一度に描いたときと同じ位置・同じ図形になる', () => {
    const s = longScore(24);
    const host = document.createElement('div');
    const view = new ScoreView(host);
    const res = view.render(s, opts);
    const f = full(s, opts);
    expect(round(res)).toEqual(round(f.res));
    expect(counts(host)).toEqual(counts(f.el));
    expect(host.querySelectorAll('.score-system').length).toBeGreaterThan(3);
  });

  it('1音変えると、その段だけ描き直す', () => {
    const s = longScore(24);
    const host = document.createElement('div');
    const view = new ScoreView(host);
    view.render(s, opts);
    const total = host.querySelectorAll('.score-system').length;
    // 同じものをもう一度描いても何も描き直さない
    view.render(s, opts);
    expect(view.lastRedrawn).toBe(0);

    (s.parts[1].measures[17].events[4] as NoteEvent).pitches = [P('G', 2)];
    const res = view.render(s, opts);
    expect(view.lastRedrawn).toBe(1);
    expect(round(res)).toEqual(round(full(s, opts).res));
    expect(host.querySelectorAll('.score-system').length).toBe(total);
  });

  it('選択・入力位置が動いたときは、前と後の段だけ描き直す', () => {
    const s = longScore(24);
    const host = document.createElement('div');
    const view = new ScoreView(host);
    view.render(s, { ...opts, selectedId: 'e0-1-0' });
    view.render(s, { ...opts, selectedId: 'e0-20-0' });
    expect(view.lastRedrawn).toBe(2);
    view.render(s, { ...opts, selectedId: 'e0-20-0', cursor: { partIndex: 0, measureIndex: 20, eventIndex: 2 } });
    expect(view.lastRedrawn).toBe(1);
  });

  it('タイトル・倍率など曲全体にかかわる変更ではすべて描き直す', () => {
    const s = longScore(12);
    const host = document.createElement('div');
    const view = new ScoreView(host);
    view.render(s, opts);
    const total = host.querySelectorAll('.score-system').length;
    s.title = '別の曲';
    view.render(s, opts);
    expect(view.lastRedrawn).toBe(total);
    view.render(s, { ...opts, scale: 1.5 });
    expect(view.lastRedrawn).toBe(total);
  });

  it('小節を消して段が減ると、余った段を片付ける', () => {
    const s = longScore(24);
    const host = document.createElement('div');
    const view = new ScoreView(host);
    view.render(s, opts);
    for (const p of s.parts) p.measures.splice(6);
    const res = view.render(s, opts);
    expect(round(res)).toEqual(round(full(s, opts).res));
    expect(counts(host)).toEqual(counts(full(s, opts).el));
  });
});
