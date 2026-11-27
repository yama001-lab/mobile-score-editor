/**
 * 五線に手書きした記号の読み取り（ステップ3）。
 * 機械学習は使わず、線の形（まっすぐか、閉じているか、塗りつぶしか、ギザギザか）と
 * 五線の間隔を物差しにした大きさで判定する。iPad上だけで軽く動くことを優先している。
 *
 * 座標はすべて楽譜の論理座標（拡大率をかける前）。長さは五線の間隔 s を単位に比べる。
 */
import { DurationType } from '../model/duration';

export interface Point { x: number; y: number }
export type Stroke = Point[];

export interface Box { x0: number; y0: number; x1: number; y1: number }

export type Recognized =
  | {
    kind: 'note';
    /** 音符の頭の中心 */
    headX: number;
    headY: number;
    /** null は「符幹なしの黒丸」：パレットで選んでいる長さを使う */
    duration: DurationType | null;
    dots: number;
    /** 頭の左に書いた臨時記号（null は書いていない） */
    alter: number | null;
    box: Box;
  }
  | { kind: 'rest'; duration: DurationType; dots: number; x: number; y: number; box: Box }
  | { kind: 'accidental'; alter: number; box: Box }
  | { kind: 'dot'; x: number; y: number; box: Box }
  | { kind: 'erase'; box: Box }
  | { kind: 'unknown'; box: Box };

export interface StaffMetrics {
  /** 五線のいちばん上の線のY */
  topLineY: number;
  lineSpacing: number;
}

// ---------- 小さな幾何の道具 ----------

export function boxOf(points: Point[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

const unionBox = (a: Box, b: Box): Box => ({
  x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
});
const bw = (b: Box) => b.x1 - b.x0;
const bh = (b: Box) => b.y1 - b.y0;
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export function pathLength(s: Stroke): number {
  let L = 0;
  for (let i = 1; i < s.length; i++) L += dist(s[i - 1], s[i]);
  return L;
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  if (!L2) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 折れ線を角だけ残して簡単にする（Ramer–Douglas–Peucker）。残した点の番号を返す */
export function simplifyIdx(s: Stroke, eps: number, lo = 0, hi = s.length - 1): number[] {
  if (hi - lo < 2) return hi > lo ? [lo, hi] : [lo];
  let maxD = 0, idx = lo;
  for (let i = lo + 1; i < hi; i++) {
    const d = distToSegment(s[i], s[lo], s[hi]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [lo, hi];
  return simplifyIdx(s, eps, lo, idx).slice(0, -1).concat(simplifyIdx(s, eps, idx, hi));
}

export function simplify(s: Stroke, eps: number): Stroke {
  return simplifyIdx(s, eps).map((i) => s[i]);
}

/** 折り返しの回数（ギザギザの判定）。いちばん端まで行ってから minStep 以上戻ったら1回と数える */
function reversals(pts: Stroke, axis: 'x' | 'y', minStep: number): number {
  if (pts.length < 2) return 0;
  let n = 0, dir = 0;
  let ext = pts[0][axis];
  for (const p of pts) {
    const v = p[axis];
    if (dir >= 0 && v > ext) { ext = v; if (!dir && v - pts[0][axis] >= minStep) dir = 1; }
    else if (dir <= 0 && v < ext) { ext = v; if (!dir && pts[0][axis] - v >= minStep) dir = -1; }
    if (dir === 1 && ext - v >= minStep) { n++; dir = -1; ext = v; }
    else if (dir === -1 && v - ext >= minStep) { n++; dir = 1; ext = v; }
  }
  return n;
}

/** 線のまっすぐさ（端から端の距離 / 線の長さ）。1 に近いほどまっすぐ */
function straightness(s: Stroke): number {
  const L = pathLength(s);
  return L ? dist(s[0], s[s.length - 1]) / L : 1;
}

/** 線の向き（0°=横、90°=縦） */
function angleDeg(a: Point, b: Point): number {
  return (Math.abs(Math.atan2(b.y - a.y, b.x - a.x)) * 180) / Math.PI;
}
const isVerticalish = (a: Point, b: Point, tol = 22) => Math.abs(angleDeg(a, b) - 90) <= tol;

/** 枠の中を n×n に分け、線が通るマスの割合を、内側と全体で返す（塗りつぶしの判定） */
function coverage(strokes: Stroke[], box: Box, n = 6): { inner: number; all: number } {
  const w = Math.max(bw(box), 1e-6), h = Math.max(bh(box), 1e-6);
  const grid = new Uint8Array(n * n);
  const mark = (p: Point) => {
    const i = Math.min(n - 1, Math.max(0, Math.floor(((p.x - box.x0) / w) * n)));
    const j = Math.min(n - 1, Math.max(0, Math.floor(((p.y - box.y0) / h) * n)));
    grid[j * n + i] = 1;
  };
  for (const s of strokes) {
    if (s.length === 1) mark(s[0]);
    for (let k = 1; k < s.length; k++) {
      const a = s[k - 1], b = s[k];
      const steps = Math.max(1, Math.ceil((dist(a, b) / Math.min(w, h)) * n * 2));
      for (let t = 0; t <= steps; t++) mark({ x: a.x + ((b.x - a.x) * t) / steps, y: a.y + ((b.y - a.y) * t) / steps });
    }
  }
  let inner = 0, innerN = 0, all = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const v = grid[j * n + i];
    all += v;
    if (i > 0 && i < n - 1 && j > 0 && j < n - 1) { inner += v; innerN++; }
  }
  return { inner: inner / innerN, all: all / (n * n) };
}

// ---------- まとまり（1つの記号）に分ける ----------

/** 近くに書いた線をまとめる。横に s×gap より離れていれば別の記号とみなす */
export function clusterStrokes(strokes: Stroke[], s: number, gap = 1.1): Stroke[][] {
  const items = strokes.filter((st) => st.length).map((st) => ({ strokes: [st], box: boxOf(st) }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i].box, b = items[j].box;
        const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
        const dy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
        if (dx <= s * gap && dy <= s * 3) {
          items[i] = { strokes: items[i].strokes.concat(items[j].strokes), box: unionBox(a, b) };
          items.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return items.sort((a, b) => a.box.x0 - b.box.x0).map((it) => it.strokes);
}

// ---------- 判定 ----------

interface StemInfo { a: Point; b: Point; stroke: number; len: number; /** 元の線での符幹の始まりと終わりの点の番号 */ i0: number; i1: number }

/** まとまりの中の縦の線分（符幹の候補）。長い順 */
function findStems(strokes: Stroke[], s: number): StemInfo[] {
  const out: StemInfo[] = [];
  strokes.forEach((st, si) => {
    const idx = simplifyIdx(st, s * 0.22);
    for (let k = 1; k < idx.length; k++) {
      const a = st[idx[k - 1]], b = st[idx[k]];
      const len = dist(a, b);
      if (len >= s * 2.1 && isVerticalish(a, b)) out.push({ a, b, stroke: si, len, i0: idx[k - 1], i1: idx[k] });
    }
  });
  return out.sort((p, q) => q.len - p.len);
}

const isTiny = (st: Stroke, s: number) => {
  const b = boxOf(st);
  return Math.max(bw(b), bh(b)) < s * 0.55;
};

/** 頭の形：閉じた輪（白丸）か塗りつぶし（黒丸）か。どちらでもなければ null */
function headKind(strokes: Stroke[], s: number): 'open' | 'filled' | null {
  const pts = strokes.flat();
  if (!pts.length) return null;
  const box = boxOf(pts);
  const w = bw(box), h = bh(box);
  // 小さすぎるもの（点）と大きすぎるものは頭ではない
  if (Math.max(w, h) < s * 0.55 || w > s * 2.6 || h > s * 2.0) return null;
  const L = strokes.reduce((t, st) => t + pathLength(st), 0);
  const perimeter = (Math.PI * (w + h)) / 2;
  const cov = coverage(strokes, box);
  const ratio = L / Math.max(perimeter, 1e-6);
  if (ratio > 1.75 || cov.inner > 0.62) return 'filled';
  // 輪：始点と終点が近い、または一周以上している
  const st = strokes.reduce((a, b) => (pathLength(b) > pathLength(a) ? b : a));
  const closed = dist(st[0], st[st.length - 1]) < Math.max(w, h) * 0.45 || ratio > 0.85;
  if (closed && ratio > 0.6) return cov.inner > 0.5 ? 'filled' : 'open';
  return null;
}

/** 臨時記号の形 */
function accidentalOf(strokes: Stroke[], s: number): number | null {
  const real = strokes.filter((st) => !isTiny(st, s));
  if (!real.length) return null;
  const box = boxOf(real.flat());
  if (bh(box) < s * 1.2 || bh(box) > s * 4.5 || bw(box) > s * 2) return null;
  if (real.length >= 3) return 1; // ♯（4本の線。3本でも許す）
  if (real.length === 2) {
    // ♯を2画（縦2本を一筆、横2本を一筆）で書くこともある。両方ジグザグなら♯
    return 0; // ♮（L字を2つ）
  }
  const st = real[0];
  const pts = st;
  const top = pts.filter((p) => p.y < box.y0 + bh(box) * 0.4);
  const topW = top.length ? bw(boxOf(top)) : 0;
  // ♭：上の部分は縦棒だけで細く、下にふくらみ
  if (topW < bw(box) * 0.4) return -1;
  return 0;
}

/** 休符の形 */
function restOf(strokes: Stroke[], s: number, staff: StaffMetrics): { duration: DurationType; dots: number } | null {
  const dots = strokes.filter((st) => isTiny(st, s));
  const real = strokes.filter((st) => !isTiny(st, s));
  if (!real.length) return null;
  const box = boxOf(real.flat());
  const w = bw(box), h = bh(box);
  const main = real.reduce((a, b) => (pathLength(b) > pathLength(a) ? b : a));
  const poly = simplify(main, s * 0.2);
  // 右にある点は付点。左上の点は8分休符の玉なので数えない
  const dotCount = dots.filter((d) => boxOf(d).x0 > box.x1 - s * 0.2).length ? 1 : 0;

  // 全休符・2分休符：横長の短い棒（塗りつぶしでも線でもよい）
  if (w >= s * 0.6 && w <= s * 2.2 && h <= s * 0.8 && real.length <= 2) {
    const cy = (box.y0 + box.y1) / 2 - staff.topLineY;
    return { duration: cy < s * 1.5 ? 'w' : 'h', dots: dotCount };
  }
  // 4分休符：縦長のギザギザ
  if (h >= s * 1.7 && w <= s * 1.6 && h > w * 1.3 && reversals(main, 'x', s * 0.25) >= 2) {
    return { duration: 'q', dots: dotCount };
  }
  // 8分・16分休符：「7」の形（上で右へ、そこから左下へ長く下りる）
  if (h >= s * 1.2 && h <= s * 4) {
    const last = poly[poly.length - 1];
    let down = -1;
    for (let k = 1; k < poly.length; k++) {
      const a = poly[k - 1], b = poly[k];
      if (b.y - a.y > s * 1.0 && b.x <= a.x + s * 0.2 && angleDeg(a, b) > 50) { down = k; break; }
    }
    if (down > 0 && last.y > box.y0 + h * 0.7) {
      // 下りる前に、右へ向かう部分がある
      const before = poly.slice(0, down);
      const rightward = before.length >= 2 && before[before.length - 1].x - before[0].x > s * 0.3;
      if (rightward || main[0].x < poly[down].x - s * 0.3) {
        // 「7」の上の玉や旗を足した数で 8分／16分
        const hooks = 1 + real.filter((st) => st !== main).length + extraHooks(poly.slice(down), s);
        return { duration: hooks >= 2 ? '16' : '8', dots: dotCount };
      }
    }
  }
  return null;
}

/** 7の斜めの線の途中から、もう一度右へ出ている（16分休符を一筆で書いた）か */
function extraHooks(poly: Stroke, s: number): number {
  let n = 0;
  for (let k = 1; k < poly.length; k++) {
    const a = poly[k - 1], b = poly[k];
    if (b.x - a.x > s * 0.4 && angleDeg(a, b) < 45) n++;
  }
  return Math.min(1, n);
}

/** 消しゴム：横にこするギザギザ、または×印 */
function isErase(strokes: Stroke[], s: number): boolean {
  const box = boxOf(strokes.flat());
  for (const st of strokes) {
    const b = boxOf(st);
    const rx = reversals(st, 'x', s * 0.6);
    // ぐるぐる塗った黒丸は縦にも同じだけ折り返すので、横の折り返しが多いものだけを消しゴムにする
    if (bw(b) >= s * 1.8 && rx >= 3 && reversals(st, 'y', s * 0.6) <= rx / 2 && bh(b) < bw(b) * 1.5) return true;
  }
  if (strokes.length === 2 && bw(box) >= s * 1.2 && bh(box) >= s * 1.2) {
    const [p, q] = strokes;
    if (straightness(p) > 0.88 && straightness(q) > 0.88) {
      const sp = slope(p), sq = slope(q);
      const diag = (a: number) => Math.abs(a) > 0.35 && Math.abs(a) < 3;
      if (diag(sp) && diag(sq) && Math.sign(sp) !== Math.sign(sq) && crosses(p, q)) return true;
    }
  }
  return false;
}

function slope(st: Stroke) {
  const a = st[0], b = st[st.length - 1];
  return (b.y - a.y) / (b.x - a.x || 1e-6);
}

function crosses(p: Stroke, q: Stroke) {
  const [a, b] = [p[0], p[p.length - 1]];
  const [c, d] = [q[0], q[q.length - 1]];
  const o = (u: Point, v: Point, w: Point) => Math.sign((v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

/** 1つのまとまりを読み取る */
export function recognizeCluster(strokes: Stroke[], staff: StaffMetrics): Recognized {
  const s = staff.lineSpacing;
  const all = strokes.flat();
  const box = boxOf(all);

  if (strokes.every((st) => isTiny(st, s))) {
    return { kind: 'dot', x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2, box };
  }
  if (isErase(strokes, s)) return { kind: 'erase', box };

  // 横長の短い棒は全休符・2分休符（黒丸と取り違えないよう、先に調べる）
  const realAll = strokes.filter((st) => !isTiny(st, s));
  const rb = boxOf(realAll.flat());
  if (bh(rb) <= s * 0.8 && bw(rb) >= Math.max(s * 0.6, bh(rb) * 2)) {
    const rest = restOf(strokes, s, staff);
    if (rest) return { kind: 'rest', ...rest, x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2, box };
  }

  for (const stem of findStems(strokes, s).slice(0, 3)) {
    const note = noteWithStem(strokes, stem, s, box);
    if (note) return note;
  }

  // 符幹のない記号：全音符、黒丸だけ、休符、臨時記号
  const real = strokes.filter((st) => !isTiny(st, s));
  const tiny = strokes.filter((st) => isTiny(st, s));
  const head = splitHeadAndAccidental(real, s);
  if (head) {
    const kind = headKind(head.head, s);
    if (kind) {
      const hb = boxOf(head.head.flat());
      const dots = tiny.filter((d) => boxOf(d).x0 >= hb.x1 - s * 0.1).length ? 1 : 0;
      return {
        kind: 'note',
        headX: (hb.x0 + hb.x1) / 2,
        headY: (hb.y0 + hb.y1) / 2,
        duration: kind === 'open' ? 'w' : null,
        dots,
        alter: head.acc.length ? accidentalOf(head.acc, s) : null,
        box,
      };
    }
  }
  const rest = restOf(strokes, s, staff);
  if (rest) return { kind: 'rest', ...rest, x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2, box };
  const acc = accidentalOf(strokes, s);
  if (acc !== null) return { kind: 'accidental', alter: acc, box };
  return { kind: 'unknown', box };
}

/** 符幹のない記号を、右端の頭と、その左の臨時記号に分ける */
function splitHeadAndAccidental(real: Stroke[], s: number): { head: Stroke[]; acc: Stroke[] } | null {
  if (!real.length) return null;
  if (real.length === 1) return { head: real, acc: [] };
  const sorted = real.slice().sort((a, b) => boxOf(b).x1 - boxOf(a).x1);
  const head = [sorted[0]];
  const hb = boxOf(sorted[0]);
  const acc: Stroke[] = [];
  for (const st of sorted.slice(1)) {
    const b = boxOf(st);
    // 頭に重なっている線は頭の一部（塗りつぶしを何回かに分けて書いた）
    if (b.x0 > hb.x0 - s * 0.3 && b.x1 < hb.x1 + s * 0.3) head.push(st);
    else acc.push(st);
  }
  return { head, acc };
}

function noteWithStem(strokes: Stroke[], stem: StemInfo, s: number, box: Box): Recognized | null {
  const top = stem.a.y < stem.b.y ? stem.a : stem.b;
  const bottom = stem.a.y < stem.b.y ? stem.b : stem.a;
  const stemX = (top.x + bottom.x) / 2;
  const onStem = (p: Point) => distToSegment(p, stem.a, stem.b) < s * 0.28;

  // 符幹以外のインクを、頭・旗・臨時記号・点に振り分ける
  type Piece = { pts: Stroke; stroke: number };
  const pieces: Piece[] = [];
  strokes.forEach((st, si) => {
    if (si !== stem.stroke) { pieces.push({ pts: st, stroke: si }); return; }
    // 符幹を含む線は、符幹の前と後に分ける（頭から一筆で符幹を書いた場合など）
    const { i0, i1 } = stem;
    const before = st.slice(0, i0 + 1);
    const after = st.slice(i1);
    if (pathLength(before) > s * 0.4) pieces.push({ pts: before, stroke: si });
    if (pathLength(after) > s * 0.4) pieces.push({ pts: after, stroke: si });
  });

  const near = (p: Point, end: Point) => Math.abs(p.y - end.y) < s * 1.3 && Math.abs(p.x - end.x) < s * 2.2;
  const score = (end: Point) => pieces.reduce((t, pc) => {
    const pts = pc.pts.filter((p) => !onStem(p) && near(p, end));
    return t + pts.length;
  }, 0);
  // 頭は、符幹の端のうちインクの多いほう（ただし旗は上端の右に出るので、下端を優先して比べる）
  const headAtBottom = score(bottom) >= score(top) * 0.8;
  const headEnd = headAtBottom ? bottom : top;
  const farEnd = headAtBottom ? top : bottom;

  const headPts: Stroke[] = [];
  const flagPieces: Piece[] = [];
  const accPieces: Stroke[] = [];
  const dotPieces: Stroke[] = [];
  for (const pc of pieces) {
    if (isTiny(pc.pts, s) && pc.stroke !== stem.stroke) {
      const b = boxOf(pc.pts);
      if (b.x0 > stemX + s * 0.2 || b.x0 > Math.max(top.x, bottom.x)) dotPieces.push(pc.pts);
      continue;
    }
    const pts = pc.pts.filter((p) => !onStem(p));
    if (!pts.length) continue;
    const nearHead = pts.filter((p) => near(p, headEnd)).length;
    const nearFar = pts.filter((p) => Math.abs(p.y - farEnd.y) < s * 2.2 && p.x > stemX - s * 0.3).length;
    const b = boxOf(pts);
    if (nearHead >= pts.length * 0.6 && b.x1 >= stemX - s * 2.4) {
      // 別の線で書いた頭は、符幹に触れている部分も含めて形を見る
      headPts.push(pc.stroke === stem.stroke ? pts : pc.pts);
    } else if (nearFar >= pts.length * 0.6) {
      flagPieces.push(pc);
    } else if (b.x1 < stemX - s * 0.5) {
      accPieces.push(pc.pts);
    }
  }
  // 頭の候補から、臨時記号（頭の左に離れて縦長）を取り除く
  let headStrokes = headPts;
  if (headPts.length > 1) {
    const rightmost = headPts.reduce((a, b) => (boxOf(b).x1 > boxOf(a).x1 ? b : a));
    const rb = boxOf(rightmost);
    headStrokes = [];
    for (const h of headPts) {
      const b = boxOf(h);
      if (h === rightmost || b.x1 > rb.x0 - s * 0.2) headStrokes.push(h);
      else accPieces.push(h);
    }
  } else if (headPts.length === 1 && bh(boxOf(headPts[0])) > s * 1.6) {
    // 縦に長すぎる「頭」は、たぶん臨時記号と頭がつながっている。右側だけを頭にする
    const b = boxOf(headPts[0]);
    const right = headPts[0].filter((p) => p.x > b.x0 + bw(b) * 0.45);
    const left = headPts[0].filter((p) => p.x <= b.x0 + bw(b) * 0.45);
    headStrokes = [right];
    accPieces.push(left);
  }
  if (!headStrokes.length) return null;
  const kind = headKind(headStrokes, s);
  if (!kind) return null;
  const hb = boxOf(headStrokes.flat());
  // 頭は符幹の端に付いている（上向きなら頭の右、下向きなら頭の左に符幹）
  const touches = Math.min(Math.abs(hb.x1 - stemX), Math.abs(hb.x0 - stemX)) < s * 0.9
    || (stemX > hb.x0 && stemX < hb.x1);
  if (!touches || Math.abs((hb.y0 + hb.y1) / 2 - headEnd.y) > s * 1.2) return null;

  let flags = 0;
  for (const f of flagPieces) {
    const pts = f.pts.filter((p) => !onStem(p));
    const b = boxOf(pts);
    if (Math.max(bw(b), bh(b)) < s * 0.6) continue;
    // 旗を2本一筆で書いた（右へ出て戻ってまた出る）
    flags += 1 + Math.floor(reversals(pts, 'x', s * 0.35) / 2);
  }
  flags = Math.min(2, flags);
  const duration: DurationType = kind === 'open' ? 'h' : flags === 0 ? 'q' : flags === 1 ? '8' : '16';
  return {
    kind: 'note',
    headX: (hb.x0 + hb.x1) / 2,
    headY: (hb.y0 + hb.y1) / 2,
    duration,
    dots: dotPieces.length ? 1 : 0,
    alter: accPieces.length ? accidentalOf(accPieces, s) : null,
    box,
  };
}
