/**
 * 記号 第2弾の描画：装飾音、D.C./D.S.・セーニョ・コーダ・Fine、オクターブ記号（8va/8vb）、ペダル。
 * render.ts と marks.ts から呼ぶ。字形は Bravura（SVG の線）なので、PDF でもフォントに頼らず同じ形になる。
 * 文字（D.S. など）はラテン文字だけなので、PDF の標準フォントで書ける。
 */
import { Accidental, GraceNote, GraceNoteGroup, Glyph, Renderer, Stave, StaveNote } from 'vexflow/bravura';
import { accidentalSymbol, keyAlter } from '../model/pitch';
import { Clef, JUMP_TEXT, MeasureAttrs, NoteEvent } from '../model/score';

type Ctx = ReturnType<Renderer['getContext']>;

/** 本音符の前に装飾音を付ける。臨時記号は調号と違う音にだけ付ける（装飾音の中では前の装飾音に合わせる） */
export function attachGraces(note: StaveNote, ev: NoteEvent, clef: Clef, key: number, color?: string): void {
  if (!ev.graces?.length) return;
  const seen = new Map<string, number>();
  const graces = ev.graces.map((g) => {
    const gn = new GraceNote({
      keys: g.pitches.map((p) => `${p.step.toLowerCase()}/${p.octave}`),
      duration: g.duration,
      slash: !!g.slash,
      clef,
    } as never);
    g.pitches.forEach((p, k) => {
      const name = `${p.step}${p.octave}`;
      const expected = seen.has(name) ? seen.get(name)! : keyAlter(key, p.step);
      if (p.alter !== expected) gn.addModifier(new Accidental(accidentalSymbol(p.alter)), k);
      seen.set(name, p.alter);
    });
    if (color) gn.setStyle({ fillStyle: color, strokeStyle: color });
    return gn;
  });
  const group = new GraceNoteGroup(graces, true);
  if (graces.length > 1) group.beamNotes();
  note.addModifier(group, 0);
}

const FLOW_FONT = 13;

function drawText(ctx: Ctx, text: string, x: number, y: number, italic = true): number {
  ctx.save();
  ctx.setFillStyle('#000');
  ctx.setFont('serif', FLOW_FONT, 'bold', italic ? 'italic' : 'normal');
  ctx.fillText(text, x, y);
  const w = ctx.measureText(text).width;
  ctx.restore();
  return w;
}

function glyph(ctx: Ctx, code: string, x: number, y: number, point: number): number {
  const g = new Glyph(code, point);
  g.render(ctx, x, y);
  return g.getMetrics().width;
}

const SEGNO_PT = 30;
const CODA_PT = 30;
const CODA_SMALL_PT = 22;

/** 当たり判定などのため、記号の幅（だいたい） */
export function glyphWidth(code: string, point: number): number {
  return new Glyph(code, point).getMetrics().width;
}

/**
 * 小節の流れの記号を、いちばん上のパートの五線の上に描く。
 * - 小節の頭：セーニョ・コーダ記号（startX から）
 * - 小節の終わり：D.C./D.S.、Fine、To Coda（小節の右端にそろえる）
 */
export function drawFlowMarks(ctx: Ctx, a: MeasureAttrs | undefined, stave: Stave, startX: number, lift = 0): void {
  if (!a) return;
  const top = stave.getYForLine(0) - lift;
  let x = startX;
  if (a.segno) x += glyph(ctx, 'segno', x, top - 14, SEGNO_PT) + 6;
  if (a.coda) {
    x += glyph(ctx, 'coda', x, top - 12, CODA_PT) + 4;
    drawText(ctx, 'Coda', x, top - 14);
  }
  const right = stave.getX() + stave.getWidth() - 6;
  const ends: string[] = [];
  if (a.fine) ends.push('Fine');
  if (a.jump) ends.push(JUMP_TEXT[a.jump]);
  let y = top - 12;
  if (a.toCoda) {
    // 「To Coda ⊕」：記号の分だけ左から
    ctx.save();
    ctx.setFont('serif', FLOW_FONT, 'bold', 'italic');
    const tw = ctx.measureText('To Coda ').width;
    ctx.restore();
    const gw = glyphWidth('coda', CODA_SMALL_PT);
    drawText(ctx, 'To Coda', right - gw - tw, y);
    glyph(ctx, 'coda', right - gw, y + 2, CODA_SMALL_PT);
    y -= 16;
  }
  for (const t of ends) {
    ctx.save();
    ctx.setFont('serif', FLOW_FONT, 'bold', 'italic');
    const w = ctx.measureText(t).width;
    ctx.restore();
    drawText(ctx, t, right - w, y);
    y -= 16;
  }
}

/**
 * オクターブ記号とペダルの線。x1〜x2 は線の範囲。段で切れたときは openStart / openEnd で端の形を変える
 * （続きの段の頭は記号を括弧付きにせず、線だけ続ける）。
 */
export function drawLineSpanner(
  ctx: Ctx, kind: '8va' | '8vb' | 'pedal', x1: number, x2: number, y: number, openStart: boolean, openEnd: boolean,
): void {
  ctx.save();
  ctx.setStrokeStyle('#000');
  ctx.setFillStyle('#000');
  ctx.setLineWidth(1);
  if (kind === 'pedal') {
    let lx = x1;
    if (!openStart) lx += glyph(ctx, 'keyboardPedalPed', x1 - 6, y, 30) - 4;
    ctx.beginPath();
    ctx.moveTo(lx, y);
    ctx.lineTo(x2, y);
    if (!openEnd) ctx.lineTo(x2, y - 10);
    ctx.stroke();
  } else {
    const above = kind === '8va';
    const label = above ? '8va' : '8vb';
    let lx = x1;
    if (!openStart) lx += drawText(ctx, label, x1 - 4, y + (above ? 0 : 4)) + 2;
    // 破線
    const dash = 5;
    const gap = 4;
    const ly = above ? y - 4 : y;
    ctx.beginPath();
    for (let x = lx; x < x2; x += dash + gap) {
      ctx.moveTo(x, ly);
      ctx.lineTo(Math.min(x + dash, x2), ly);
    }
    if (!openEnd) {
      ctx.moveTo(x2, ly);
      ctx.lineTo(x2, ly + (above ? 8 : -8));
    }
    ctx.stroke();
  }
  ctx.restore();
}
