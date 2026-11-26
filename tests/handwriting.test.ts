import { describe, expect, it } from 'vitest';
import { Point, Stroke, clusterStrokes, recognizeCluster } from '../src/handwriting/recognize';

const S = 10; // 五線の間隔
const staff = { topLineY: 100, lineSpacing: S };

/** 白丸（楕円を1周と少し） */
function ellipse(cx: number, cy: number, rx = 6.5, ry = 4.5, turns = 1.1): Stroke {
  const pts: Point[] = [];
  const n = Math.round(40 * turns);
  for (let i = 0; i <= n; i++) {
    const t = (i / 40) * Math.PI * 2;
    pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return pts;
}
/** 黒丸（ぐるぐる塗りつぶす） */
function filled(cx: number, cy: number): Stroke {
  const pts: Point[] = [];
  for (let i = 0; i <= 160; i++) {
    const t = (i / 40) * Math.PI * 2;
    const r = 1 - (i / 160) * 0.85;
    pts.push({ x: cx + 6 * r * Math.cos(t), y: cy + 4.5 * r * Math.sin(t) });
  }
  return pts;
}
function line(x0: number, y0: number, x1: number, y1: number, n = 12): Stroke {
  return Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n }));
}
function poly(...xy: number[]): Stroke {
  const out: Point[] = [];
  for (let i = 0; i + 3 < xy.length; i += 2) out.push(...line(xy[i], xy[i + 1], xy[i + 2], xy[i + 3], 8).slice(i ? 1 : 0));
  return out;
}
const dot = (x: number, y: number): Stroke => [{ x, y }, { x: x + 1, y: y + 1 }];
/** 旗（符幹の上端から右下へ曲がる） */
const flag = (x: number, y: number) => poly(x, y, x + 5, y + 8, x + 8, y + 16);

const rec = (...strokes: Stroke[]) => { const r = recognizeCluster(strokes, staff); if (process.env.DBG) console.log(JSON.stringify(r)); return r; };
// 第3線（真ん中の線）は y=120
const mid = 120;

describe('手書きの音符', () => {
  it('白丸だけは全音符', () => {
    const r = rec(ellipse(50, mid));
    expect(r).toMatchObject({ kind: 'note', duration: 'w', dots: 0, alter: null });
    if (r.kind === 'note') expect(Math.abs(r.headY - mid)).toBeLessThan(2);
  });
  it('白丸＋符幹は2分音符', () => {
    expect(rec(ellipse(50, mid), line(56, mid, 56, mid - 35))).toMatchObject({ kind: 'note', duration: 'h' });
  });
  it('黒丸＋符幹は4分音符（符幹が下向きでも）', () => {
    expect(rec(filled(50, mid), line(56, mid, 56, mid - 35))).toMatchObject({ kind: 'note', duration: 'q' });
    const down = rec(filled(50, 105), line(44, 105, 44, 140));
    expect(down).toMatchObject({ kind: 'note', duration: 'q' });
    if (down.kind === 'note') expect(Math.abs(down.headY - 105)).toBeLessThan(3);
  });
  it('黒丸だけはパレットの長さ（null）', () => {
    expect(rec(filled(50, mid))).toMatchObject({ kind: 'note', duration: null });
  });
  it('旗の数で8分・16分', () => {
    const st = line(56, mid, 56, mid - 35);
    expect(rec(filled(50, mid), st, flag(56, mid - 35))).toMatchObject({ duration: '8' });
    expect(rec(filled(50, mid), st, flag(56, mid - 35), flag(56, mid - 27))).toMatchObject({ duration: '16' });
  });
  it('頭から一筆で符幹と旗を書いても読める', () => {
    const one = filled(50, mid).concat(poly(56, mid, 56, mid - 35, 61, mid - 27, 64, mid - 19));
    expect(rec(one)).toMatchObject({ kind: 'note', duration: '8' });
  });
  it('右の点は付点', () => {
    expect(rec(filled(50, mid), line(56, mid, 56, mid - 35), dot(64, mid))).toMatchObject({ duration: 'q', dots: 1 });
    expect(rec(ellipse(50, mid), line(56, mid, 56, mid - 35), dot(64, mid))).toMatchObject({ duration: 'h', dots: 1 });
  });
  it('頭の左の臨時記号', () => {
    const sharp = [line(30, mid - 12, 30, mid + 12), line(36, mid - 14, 36, mid + 10), line(26, mid - 3, 40, mid - 6), line(26, mid + 5, 40, mid + 2)];
    expect(rec(...sharp, filled(50, mid), line(56, mid, 56, mid - 35))).toMatchObject({ kind: 'note', alter: 1, duration: 'q' });
    const flat = poly(32, mid - 22, 32, mid + 5, 38, mid - 1, 40, mid + 2, 32, mid + 5);
    expect(rec(flat, filled(50, mid), line(56, mid, 56, mid - 35))).toMatchObject({ kind: 'note', alter: -1 });
    expect(rec(flat, ellipse(50, mid))).toMatchObject({ kind: 'note', alter: -1, duration: 'w' });
  });
});

describe('手書きの休符・その他', () => {
  it('横の短い棒は全休符（上）と2分休符（下）', () => {
    expect(rec(line(45, 112, 58, 112))).toMatchObject({ kind: 'rest', duration: 'w' });
    expect(rec(line(45, 118, 58, 118))).toMatchObject({ kind: 'rest', duration: 'h' });
  });
  it('縦のギザギザは4分休符', () => {
    expect(rec(poly(50, 105, 57, 113, 49, 120, 57, 128, 50, 136))).toMatchObject({ kind: 'rest', duration: 'q' });
  });
  it('「7」の形は8分休符', () => {
    expect(rec(poly(45, 110, 57, 110, 49, 132))).toMatchObject({ kind: 'rest', duration: '8' });
    expect(rec(dot(45, 111), poly(46, 112, 57, 110, 49, 132))).toMatchObject({ kind: 'rest', duration: '8' });
  });
  it('横にこするか×印で消す', () => {
    expect(rec(poly(40, 120, 60, 118, 41, 122, 61, 117, 40, 123, 60, 119))).toMatchObject({ kind: 'erase' });
    expect(rec(line(40, 105, 60, 130), line(60, 105, 40, 130))).toMatchObject({ kind: 'erase' });
  });
  it('点だけ・臨時記号だけ', () => {
    expect(rec(dot(50, 120))).toMatchObject({ kind: 'dot' });
    expect(rec(line(30, 108, 30, 132), line(36, 106, 36, 130), line(26, 117, 40, 114), line(26, 125, 40, 122))).toMatchObject({ kind: 'accidental', alter: 1 });
  });
  it('離れて書いた記号は別のまとまりになる', () => {
    const groups = clusterStrokes([filled(50, mid), line(56, mid, 56, mid - 35), filled(90, 110), line(96, 110, 96, 75)], S);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(2);
  });
});

describe('手ぶれがあっても読める', () => {
  /** 決まった乱数（毎回同じ結果になるように） */
  function rng(seed: number) {
    return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  }
  const jitter = (r: () => number, amp: number, ...strokes: Stroke[]) =>
    strokes.map((st) => st.map((p) => ({ x: p.x + r() * amp, y: p.y + r() * amp })));

  const cases: [string, () => Stroke[], Record<string, unknown>][] = [
    ['全音符', () => [ellipse(50, mid)], { kind: 'note', duration: 'w' }],
    ['2分', () => [ellipse(50, mid), line(56, mid, 56, mid - 35)], { kind: 'note', duration: 'h' }],
    ['4分', () => [filled(50, mid), line(56, mid, 56, mid - 35)], { kind: 'note', duration: 'q' }],
    ['8分', () => [filled(50, mid), line(56, mid, 56, mid - 35), flag(56, mid - 35)], { kind: 'note', duration: '8' }],
    ['4分休符', () => [poly(50, 105, 57, 113, 49, 120, 57, 128, 50, 136)], { kind: 'rest', duration: 'q' }],
    ['消す', () => [poly(40, 120, 60, 118, 41, 122, 61, 117, 40, 123, 60, 119)], { kind: 'erase' }],
  ];
  for (const [name, make, want] of cases) {
    it(name, () => {
      let ok = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const r = recognizeCluster(jitter(rng(seed), 1.6, ...make()), staff);
        if (Object.entries(want).every(([k, v]) => (r as Record<string, unknown>)[k] === v)) ok++;
      }
      expect(ok).toBeGreaterThanOrEqual(18);
    });
  }
});
