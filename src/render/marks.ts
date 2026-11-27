/**
 * 記号の描画：アーティキュレーション（音符に付ける）、強弱記号、クレッシェンド／ディミヌエンド（ヘアピン）、スラー。
 * render.ts から呼ぶ。強弱記号は Bravura の字形（SVGの線）で描くので、PDFでもフォントに頼らず同じ形になる。
 */
import { Articulation as VfArticulation, Glyph, Modifier, Renderer, StaveNote } from 'vexflow/bravura';
import { resolveSpanners } from '../model/marks';
import { drawLineSpanner } from './notation';
import { Articulation, Dynamic, MusicEvent, Score, measureEvents } from '../model/score';

type Ctx = ReturnType<Renderer['getContext']>;

const ART_CODES: Record<Articulation, string> = {
  staccato: 'a.', accent: 'a>', tenuto: 'a-', marcato: 'a^', fermata: 'a@a',
};

/** 音符に VexFlow のアーティキュレーションを付ける。フェルマータは上、それ以外は符頭の側 */
export function attachArticulations(note: StaveNote, ev: MusicEvent): void {
  if (!ev.articulations?.length) return;
  const stemUp = ev.kind === 'note' && note.getStemDirection() === 1;
  for (const a of ev.articulations) {
    if (ev.kind === 'rest' && a !== 'fermata') continue;
    const art = new VfArticulation(ART_CODES[a]);
    // マルカートは慣習で上に置く
    const above = a === 'fermata' || a === 'marcato' || ev.kind === 'rest' || !stemUp;
    art.setPosition(above ? Modifier.Position.ABOVE : Modifier.Position.BELOW);
    note.addModifier(art, 0);
  }
}

const DYN_GLYPHS: Record<string, string> = {
  p: 'dynamicPiano', m: 'dynamicMezzo', f: 'dynamicForte', s: 'dynamicSforzando', z: 'dynamicZ',
};
const DYN_POINT = 34;

function dynamicWidth(d: Dynamic): number {
  return [...d].reduce((w, ch) => w + new Glyph(DYN_GLYPHS[ch], DYN_POINT).getMetrics().width, 0);
}

/** 強弱記号を x を中心に、y をベースラインにして描く。描いた幅を返す */
export function drawDynamic(ctx: Ctx, d: Dynamic, x: number, y: number): number {
  const w = dynamicWidth(d);
  let cx = x - w / 2;
  for (const ch of d) {
    const g = new Glyph(DYN_GLYPHS[ch], DYN_POINT);
    g.render(ctx, cx, y);
    cx += g.getMetrics().width;
  }
  return w;
}

/** 描いた音符の情報（render.ts が集める） */
export interface PlacedNote {
  note: StaveNote;
  system: number;
}

/** 段（システム）ごとの、音符を置ける左右の端と、パートごとの第5線（いちばん下の線）のY */
export interface SystemBox {
  x0: number;
  x1: number;
  bottoms: number[];
  tops: number[];
}

function headX(n: StaveNote) {
  return (n.getNoteHeadBeginX() + n.getNoteHeadEndX()) / 2;
}

/** 強弱記号とヘアピンの高さ：五線の下。低い音があればそれより下 */
function dynamicsY(box: SystemBox, partIndex: number, notes: StaveNote[]) {
  let y = box.bottoms[partIndex] + 32;
  for (const n of notes) {
    const low = Math.max(...n.getYs(), n.getStemDirection() === -1 && !n.isRest() ? n.getStemExtents().topY : -Infinity);
    y = Math.max(y, low + 24);
  }
  return y;
}

/**
 * スラーを描く。音符の位置を見て上か下かを決める（両方とも符幹が上なら下、それ以外は上）。
 * 段をまたぐときは、それぞれの段の端までで切る。
 */
function drawSlur(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, above: boolean) {
  const dir = above ? -1 : 1;
  const len = Math.max(10, x2 - x1);
  const h = Math.min(8 + len * 0.06, 22) * dir;
  const thick = 2 * dir;
  const cx1 = x1 + len * 0.25;
  const cx2 = x2 - len * 0.25;
  ctx.save();
  ctx.setFillStyle('#000');
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.bezierCurveTo(cx1, y1 + h, cx2, y2 + h, x2, y2);
  ctx.bezierCurveTo(cx2, y2 + h + thick, cx1, y1 + h + thick, x1, y1);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function slurEndY(n: StaveNote, above: boolean): number {
  const ys = n.getYs();
  if (n.isRest()) return above ? Math.min(...ys) - 12 : Math.max(...ys) + 12;
  const up = n.getStemDirection() === 1;
  const tip = n.getStemExtents().topY;
  if (above) return up ? tip - 4 : Math.min(...ys) - 7;
  return up ? Math.max(...ys) + 7 : tip + 4;
}

function drawHairpin(ctx: Ctx, kind: 'cresc' | 'dim', x1: number, x2: number, y: number, openStart: boolean, openEnd: boolean) {
  const H = 5.5;
  // 段で切れたとき、切れ目の開き具合は中間にする
  let a = kind === 'cresc' ? 0 : H;
  let b = kind === 'cresc' ? H : 0;
  if (openStart && kind === 'cresc') a = H / 2;
  if (openEnd && kind === 'dim') b = H / 2;
  ctx.save();
  ctx.setStrokeStyle('#000');
  ctx.setLineWidth(1.1);
  ctx.beginPath();
  ctx.moveTo(x1, y - a);
  ctx.lineTo(x2, y - b);
  ctx.moveTo(x1, y + a);
  ctx.lineTo(x2, y + b);
  ctx.stroke();
  ctx.restore();
}

/** 強弱記号・ヘアピン・スラーをまとめて描く（ページ内の音符だけ） */
export function drawMarks(
  ctx: Ctx, score: Score, placed: Map<string, PlacedNote>, boxes: SystemBox[], partOf: Map<string, number>,
  /** このページに描く小節の範囲。両端がページの外で、ページ全体にかかるスパナーも描くために使う */
  span?: { first: number; last: number },
): void {
  // 強弱記号
  const dynWidth = new Map<string, number>();
  for (const part of score.parts) for (const m of part.measures) for (const ev of measureEvents(m)) {
    if (!ev.dynamic) continue;
    const pn = placed.get(ev.id);
    if (!pn) continue;
    const pi = partOf.get(ev.id) ?? 0;
    const y = dynamicsY(boxes[pn.system], pi, [pn.note]) + 4;
    dynWidth.set(ev.id, drawDynamic(ctx, ev.dynamic, headX(pn.note), y));
  }

  const resolved = resolveSpanners(score);
  const dynParts = new Set<number>();
  score.parts.forEach((part, pi) => {
    if (part.measures.some((m) => measureEvents(m).some((e) => e.dynamic))) dynParts.add(pi);
  });
  for (const r of resolved) if (r.spanner.kind === 'cresc' || r.spanner.kind === 'dim') dynParts.add(r.partIndex);
  for (const r of resolved) {
    const a = placed.get(r.from.ev.id);
    const b = placed.get(r.to.ev.id);
    // 両端ともページの外：ページ全体にかかるときだけ、全部の段に線を引く
    if (!a && !b && !(span && r.from.loc.measureIndex < span.first && r.to.loc.measureIndex > span.last)) continue;
    const pi = r.partIndex;
    const sysA = a?.system ?? b?.system ?? 0;
    const sysB = b?.system ?? a?.system ?? boxes.length - 1;
    // 別の段（またはページ外）にまたがるときは段ごとに分けて描く
    const segments: { sys: number; from?: StaveNote; to?: StaveNote }[] = [];
    if (a && b && sysA === sysB) segments.push({ sys: sysA, from: a.note, to: b.note });
    else {
      if (a) segments.push({ sys: sysA, from: a.note });
      for (let s = (a ? sysA + 1 : 0); s < (b ? sysB : boxes.length); s++) segments.push({ sys: s });
      if (b) segments.push({ sys: sysB, to: b.note });
    }
    for (const seg of segments) {
      const box = boxes[seg.sys];
      if (!box) continue;
      if (r.spanner.kind === 'slur') {
        const notes = [seg.from, seg.to].filter((n): n is StaveNote => !!n);
        const allUp = notes.every((n) => !n.isRest() && n.getStemDirection() === 1);
        // 2声部の小節では、声部1のスラーは上、声部2のスラーは下（もう片方の声部とぶつけない）
        const twoVoices = [r.from, r.to].some((fe) => !!score.parts[pi].measures[fe.loc.measureIndex]?.voice2);
        const above = r.voice ? false : twoVoices ? true : !allUp;
        const x1 = seg.from ? headX(seg.from) + 2 : box.x0;
        const x2 = seg.to ? headX(seg.to) - 2 : box.x1;
        const edgeY = above ? box.tops[pi] - 6 : box.bottoms[pi] + 6;
        const y1 = seg.from ? slurEndY(seg.from, above) : (seg.to ? slurEndY(seg.to, above) : edgeY);
        const y2 = seg.to ? slurEndY(seg.to, above) : y1;
        drawSlur(ctx, x1, y1, x2, y2, above);
      } else if (r.spanner.kind === '8va' || r.spanner.kind === '8vb' || r.spanner.kind === 'pedal') {
        const notes = [seg.from, seg.to].filter((n): n is StaveNote => !!n);
        const kind = r.spanner.kind;
        let y: number;
        if (kind === '8va') {
          y = box.tops[pi] - 16;
          for (const n of notes) y = Math.min(y, Math.min(...n.getYs(), n.getStemDirection() === 1 && !n.isRest() ? n.getStemExtents().topY : Infinity) - 12);
        } else if (kind === '8vb') {
          y = box.bottoms[pi] + 26;
          for (const n of notes) y = Math.max(y, Math.max(...n.getYs(), n.getStemDirection() === -1 && !n.isRest() ? n.getStemExtents().topY : -Infinity) + 16);
        } else {
          // 強弱記号・ヘアピンのあるパートではその下、なければ五線（と低い音）のすぐ下
          y = dynamicsY(box, pi, notes) + (dynParts.has(pi) ? 22 : 0);
        }
        const x1 = seg.from ? headX(seg.from) - 4 : box.x0;
        const x2 = seg.to ? headX(seg.to) + 10 : box.x1;
        drawLineSpanner(ctx, kind, x1, Math.max(x1 + 14, x2), y, !seg.from, !seg.to);
      } else {
        const notes = [seg.from, seg.to].filter((n): n is StaveNote => !!n);
        const y = dynamicsY(box, pi, notes);
        const fromDyn = seg.from ? dynWidth.get(r.from.ev.id) : undefined;
        let x1 = seg.from ? headX(seg.from) + (fromDyn ? fromDyn / 2 + 4 : -4) : box.x0;
        // 終わりの音符に強弱記号があれば、その手前で止める
        const toDyn = seg.to ? dynWidth.get(r.to.ev.id) : undefined;
        let x2 = seg.to ? headX(seg.to) + (toDyn ? -toDyn / 2 - 4 : 8) : box.x1;
        if (x2 - x1 < 14) { const mid = (x1 + x2) / 2; x1 = mid - 7; x2 = mid + 7; }
        drawHairpin(ctx, r.spanner.kind, x1, x2, y - 4, !seg.from, !seg.to);
      }
    }
  }
}
