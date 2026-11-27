/**
 * 歌詞・コードネーム・譜表の上の文字・練習番号の描画（render.ts から呼ぶ）。
 * - 文字の幅は canvas で測り、音符の間隔が足りるように見えない Annotation を音符に付ける
 * - PDF では日本語が PDF 標準フォントにないため、textSink に渡して画像で載せる（export/pdf.ts）
 */
import { Annotation, StaveNote } from 'vexflow/bravura';
import { MusicEvent, Score, measureEvents } from '../model/score';
import { resolveSpanners } from '../model/marks';
import { formatChord, partVerses, splitSyllable } from '../model/texts';

export interface TextFont {
  family: string;
  size: number;
  weight?: 'normal' | 'bold';
  style?: 'normal' | 'italic';
}

/** 描く文字1つ。x は左端、y はベースライン（楽譜の論理座標） */
export interface TextItem {
  x: number;
  y: number;
  text: string;
  font: TextFont;
}

export type TextKind = 'lyric' | 'chord' | 'text' | 'rehearsal';

/** 文字の当たり判定（タップで直すため） */
export interface TextHit {
  kind: TextKind;
  partIndex: number;
  measureIndex: number;
  /** 練習番号以外 */
  eventId?: string;
  verse?: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** いま入力中の文字（薄い青で示す） */
export interface TextFocus {
  kind: TextKind;
  eventId?: string;
  measureIndex?: number;
  verse?: number;
}

const JA_SERIF = '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif JP", "Times New Roman", serif';
const JA_SANS = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", Arial, sans-serif';

export const FONTS = {
  lyric: { family: JA_SERIF, size: 14 } as TextFont,
  chord: { family: JA_SANS, size: 15, weight: 'bold' } as TextFont,
  text: { family: JA_SERIF, size: 13, style: 'italic' } as TextFont,
  rehearsal: { family: JA_SANS, size: 15, weight: 'bold' } as TextFont,
};

const LYRIC_LINE = 18;
const COLOR_FOCUS = 'rgba(21,101,192,0.18)';

export function cssFont(f: TextFont): string {
  return `${f.style ?? 'normal'} ${f.weight ?? 'normal'} ${f.size}px ${f.family}`;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** 文字の幅（px）。canvas が使えない環境（試験）では文字数から見積もる */
export function textWidth(text: string, font: TextFont): number {
  if (measureCtx === undefined) {
    measureCtx = null;
    try {
      const jsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);
      if (!jsdom && typeof document !== 'undefined') measureCtx = document.createElement('canvas').getContext('2d');
    } catch { measureCtx = null; }
  }
  if (measureCtx) {
    measureCtx.font = cssFont(font);
    return measureCtx.measureText(text).width;
  }
  let w = 0;
  for (const ch of text) w += /[　-鿿＀-￯]/.test(ch) ? 1 : 0.58;
  return w * font.size;
}

// ---------- 音符の間隔を空ける ----------

/** 描かない Annotation。VexFlow の整形で、文字の幅だけ音符の左右を空けてもらうために使う */
class Spacer extends Annotation {
  draw() { /* 文字は texts.ts で描く */ }
}

/** VexFlow 内蔵の文字幅表での "H" の幅（大きさ1あたり）。Annotation の幅をこれで合わせる */
const H_EM = 0.963;
function spacer(width: number, justify: 'center' | 'right'): Spacer {
  const a = new Spacer('H');
  a.setFont({ family: 'Arial, sans-serif', size: Math.max(1, width / H_EM) });
  a.setJustification(justify === 'center' ? Annotation.HorizontalJustify.CENTER : Annotation.HorizontalJustify.RIGHT);
  a.setVerticalJustification(Annotation.VerticalJustify.BOTTOM);
  return a;
}

/** 歌詞・コードネームの幅のぶん、音符の左右に余白を取る */
export function addTextSpacers(note: StaveNote, ev: MusicEvent): void {
  if (ev.kind === 'note' && ev.lyrics?.length) {
    const w = Math.max(...ev.lyrics.map((l) => (l ? textWidth(splitSyllable(l).text, FONTS.lyric) + (/-$/.test(l) ? 14 : 6) : 0)));
    if (w > 14) note.addModifier(spacer(w, 'center'), 0);
  }
  if (ev.chord) note.addModifier(spacer(textWidth(formatChord(ev.chord), FONTS.chord) + 6, 'right'), 0);
}

// ---------- 縦の配置 ----------

export interface PartSpacing {
  /** 譜表の上に足す高さ */
  above: number;
  /** 譜表の下に足す高さ（歌詞の行の分） */
  below: number;
  /** 歌詞の行の数（声部1の番の数＋声部2の番の数） */
  verses: number;
  /** 声部1の歌詞の番の数。声部2の歌詞はその下の行に書く */
  voice1Verses: number;
  hasChord: boolean;
  hasText: boolean;
  /** 強弱記号・ヘアピンがあるとき、歌詞はその下に下げる */
  hasDynamics: boolean;
  /** 声部2のスラー（五線の下に描く）があるとき、歌詞はその下に下げる */
  hasLowSlur: boolean;
}

/** 五線の下のスラーの分、歌詞を下げる高さ */
const LOW_SLUR_ROW = 14;

/** 強弱記号・ヘアピンの行の高さ（歌詞をその下に置く分） */
const DYNAMICS_ROW = 28;

export function partSpacing(score: Score): PartSpacing[] {
  return score.parts.map((part, pi) => {
    let hasChord = false;
    let hasText = false;
    let hasDynamics = false;
    const ids = new Set<string>();
    for (const m of part.measures) for (const e of measureEvents(m)) {
      if (e.chord) hasChord = true;
      if (e.text) hasText = true;
      if (e.dynamic) hasDynamics = true;
      ids.add(e.id);
    }
    if (score.spanners?.some((s) => s.kind !== 'slur' && ids.has(s.from))) hasDynamics = true;
    const hasLowSlur = resolveSpanners(score).some((r) => r.partIndex === pi && r.voice === 1 && r.spanner.kind === 'slur');
    const voice1Verses = partVerses(score, pi, 0);
    const verses = voice1Verses + partVerses(score, pi, 1);
    const rehearsal = pi === 0 && score.parts[0].measures.some((m) => m.rehearsal);
    const need = (hasChord ? 20 : 0) + (hasText ? 18 : 0) + (rehearsal ? 24 : 0);
    return {
      above: Math.max(0, need - 22),
      below: verses ? verses * LYRIC_LINE + 8 + (hasDynamics ? DYNAMICS_ROW : 0) + (hasLowSlur ? LOW_SLUR_ROW : 0) : 0,
      verses,
      voice1Verses,
      hasChord,
      hasText,
      hasDynamics,
      hasLowSlur,
    };
  });
}

// ---------- 描く ----------

type Ctx = {
  save(): unknown; restore(): unknown; setFont(f: string, s: number, w?: string, st?: string): unknown;
  fillText(t: string, x: number, y: number): unknown; setFillStyle(s: string): unknown; setStrokeStyle(s: string): unknown;
  fillRect(x: number, y: number, w: number, h: number): unknown; rect(x: number, y: number, w: number, h: number): unknown;
  beginPath(): unknown; stroke(): unknown; setLineWidth(w: number): unknown;
};

export interface SystemTextEntry {
  partIndex: number;
  measureIndex: number;
  /** 0=声部1、1=声部2（省略時は声部1） */
  voice?: number;
  ev: MusicEvent;
  note: StaveNote;
  topLineY: number;
  bottomLineY: number;
}

export interface MeasureStart {
  measureIndex: number;
  x: number;
  topLineY: number;
}

/** ページをまたいで続く状態（ハイフンの続き） */
export interface TextState {
  /** パート・番ごとの、ハイフンでつなぐ途中の音節 */
  pendingHyphen: Map<string, { x: number; y: number; system: number }>;
}

export function newTextState(): TextState {
  return { pendingHyphen: new Map() };
}

export interface DrawTextsOptions {
  sink?: (item: TextItem) => void;
  focus?: TextFocus | null;
  spacing: PartSpacing[];
}

function put(ctx: Ctx, item: TextItem, sink?: (i: TextItem) => void) {
  if (sink) { sink(item); return; }
  ctx.save();
  ctx.setFillStyle('#000');
  ctx.setFont(item.font.family, item.font.size, item.font.weight ?? 'normal', item.font.style ?? 'normal');
  ctx.fillText(item.text, item.x, item.y);
  ctx.restore();
}

function focusBox(ctx: Ctx, x: number, y: number, w: number, h: number) {
  ctx.save();
  ctx.setFillStyle(COLOR_FOCUS);
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function noteCenter(n: StaveNote): number {
  return n.getAbsoluteX() + n.getGlyphWidth() / 2;
}

function noteExtent(n: StaveNote): { top: number; bottom: number } {
  try {
    const bb = n.getBoundingBox();
    if (bb) return { top: bb.getY(), bottom: bb.getY() + bb.getH() };
  } catch { /* 下で見積もる */ }
  const ys = n.getYs();
  return { top: Math.min(...ys) - 8, bottom: Math.max(...ys) + 8 };
}

/** 1段（システム）分の文字を描き、当たり判定を返す */
export function drawSystemTexts(
  ctx: Ctx, score: Score, entries: SystemTextEntry[], starts: MeasureStart[], system: number,
  state: TextState, o: DrawTextsOptions,
): TextHit[] {
  const hits: TextHit[] = [];
  const focus = o.focus;
  const byPart = new Map<number, SystemTextEntry[]>();
  for (const e of entries) (byPart.get(e.partIndex) ?? byPart.set(e.partIndex, []).get(e.partIndex)!).push(e);

  let rehearsalBase = Infinity;
  byPart.forEach((list, pi) => {
    const sp = o.spacing[pi];
    const top = list[0].topLineY;
    const bottom = list[0].bottomLineY;
    let minTop = top;
    let maxBottom = bottom;
    for (const e of list) {
      if (e.ev.kind !== 'note') continue;
      const x = noteExtent(e.note);
      minTop = Math.min(minTop, x.top);
      maxBottom = Math.max(maxBottom, x.bottom);
    }
    const chordY = Math.min(top - 10, minTop - 7);
    const textY = sp.hasChord ? chordY - 19 : chordY;
    const lyricY = Math.max(bottom + 24, maxBottom + 17) + (sp.hasDynamics ? DYNAMICS_ROW : 0) + (sp.hasLowSlur ? LOW_SLUR_ROW : 0);
    if (pi === 0) rehearsalBase = (sp.hasText ? textY : sp.hasChord ? chordY : top - 10) - 22;

    for (const e of list) {
      const ev = e.ev;
      const cx = noteCenter(e.note);
      const left = e.note.getAbsoluteX() - 2;
      const isFocus = (kind: TextKind, verse?: number) =>
        !!focus && focus.kind === kind && focus.eventId === ev.id && (verse === undefined || focus.verse === verse);

      // コードネーム
      const chord = ev.chord ? formatChord(ev.chord) : '';
      if (chord || isFocus('chord')) {
        const w = chord ? textWidth(chord, FONTS.chord) : 0;
        if (isFocus('chord')) focusBox(ctx, left - 3, chordY - 16, Math.max(w, 14) + 6, 21);
        if (chord) put(ctx, { x: left, y: chordY, text: chord, font: FONTS.chord }, o.sink);
        hits.push({ kind: 'chord', partIndex: pi, measureIndex: e.measureIndex, eventId: ev.id, x: left - 4, y: chordY - 18, w: Math.max(w, 14) + 8, h: 24 });
      }
      // 譜表の上の文字
      if (ev.text || isFocus('text')) {
        const w = ev.text ? textWidth(ev.text, FONTS.text) : 0;
        if (isFocus('text')) focusBox(ctx, left - 3, textY - 14, Math.max(w, 14) + 6, 19);
        if (ev.text) put(ctx, { x: left, y: textY, text: ev.text, font: FONTS.text }, o.sink);
        hits.push({ kind: 'text', partIndex: pi, measureIndex: e.measureIndex, eventId: ev.id, x: left - 4, y: textY - 16, w: Math.max(w, 14) + 8, h: 22 });
      }
      // 歌詞
      if (ev.kind !== 'note') continue;
      const verses = Math.max(ev.lyrics?.length ?? 0, focus?.kind === 'lyric' && focus.eventId === ev.id ? (focus.verse ?? 0) + 1 : 0);
      // 声部2の歌詞は、声部1の歌詞の行の下に続けて書く
      const voice = e.voice ?? 0;
      const row0 = voice ? sp.voice1Verses : 0;
      for (let v = 0; v < verses; v++) {
        const raw = ev.lyrics?.[v] ?? '';
        const y = lyricY + (row0 + v) * LYRIC_LINE;
        const { text, hyphen } = splitSyllable(raw);
        const w = text ? textWidth(text, FONTS.lyric) : 0;
        const x = cx - w / 2;
        const key = `${pi}:${voice}:${v}`;
        if (isFocus('lyric', v)) focusBox(ctx, Math.min(x, cx - 7) - 3, y - 14, Math.max(w, 14) + 6, 19);
        if (!text) continue;
        const prev = state.pendingHyphen.get(key);
        if (prev) {
          state.pendingHyphen.delete(key);
          if (prev.system === system) {
            const gap = x - prev.x;
            if (gap > 8) put(ctx, { x: prev.x + gap / 2 - 3, y: prev.y, text: '-', font: FONTS.lyric }, o.sink);
          } else {
            // 段が変わったときは、前の段の終わりに付ける
            put(ctx, { x: prev.x + 4, y: prev.y, text: '-', font: FONTS.lyric }, o.sink);
          }
        }
        put(ctx, { x, y, text, font: FONTS.lyric }, o.sink);
        hits.push({ kind: 'lyric', partIndex: pi, measureIndex: e.measureIndex, eventId: ev.id, verse: v, x: x - 4, y: y - 16, w: w + 8, h: 21 });
        if (hyphen) state.pendingHyphen.set(key, { x: x + w, y, system });
      }
    }
  });

  // 練習番号（四角で囲む）
  if (rehearsalBase === Infinity && starts.length) rehearsalBase = starts[0].topLineY - 32;
  for (const s of starts) {
    const m = score.parts[0].measures[s.measureIndex];
    const isFocus = focus?.kind === 'rehearsal' && focus.measureIndex === s.measureIndex;
    if (!m?.rehearsal && !isFocus) continue;
    const label = m?.rehearsal ?? '';
    const w = rehearsalWidth(label);
    const x = s.x - 4;
    const y = rehearsalBase;
    if (isFocus) focusBox(ctx, x - 3, y - 19, w + 6, 26);
    if (label) {
      ctx.save();
      ctx.setStrokeStyle('#000');
      ctx.setLineWidth(1.4);
      ctx.beginPath();
      ctx.rect(x, y - 16, w, 21);
      ctx.stroke();
      ctx.restore();
      put(ctx, { x: x + 5, y: y, text: label, font: FONTS.rehearsal }, o.sink);
    }
    hits.push({ kind: 'rehearsal', partIndex: 0, measureIndex: s.measureIndex, x: x - 2, y: y - 18, w: w + 4, h: 25 });
  }
  return hits;
}

/** ページの終わりで、次の段へ続くハイフンを描いておく */
export function flushHyphens(ctx: Ctx, state: TextState, sink?: (i: TextItem) => void) {
  for (const p of state.pendingHyphen.values()) put(ctx, { x: p.x + 4, y: p.y, text: '-', font: FONTS.lyric }, sink);
  state.pendingHyphen.clear();
}

/** 練習番号の四角の幅（テンポ表記をその右へずらすのにも使う） */
export function rehearsalWidth(label: string): number {
  return Math.max(textWidth(label, FONTS.rehearsal), 10) + 10;
}
