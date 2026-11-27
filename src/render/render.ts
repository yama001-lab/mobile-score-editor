/**
 * 楽譜を VexFlow で SVG に描く。画面表示とPDF書き出しで同じ処理を使う。
 * 描いた音符の位置（HitMap）を返し、タップ・ペン入力の当たり判定に使う。
 */
import {
  Accidental, Beam, Dot, Formatter, Renderer, Stave, StaveConnector, StaveNote, StaveTie, Tuplet, Voice,
} from 'vexflow/bravura';
import { diatonicIndex, keyAlter, keyName, accidentalSymbol } from '../model/pitch';
import { Clef, MusicEvent, Score, measureCapacity, tempoMarkAt } from '../model/score';

export interface RenderOptions {
  /** 描画に使う論理幅（px） */
  width: number;
  /** 拡大率 */
  scale?: number;
  selectedId?: string | null;
  selectedPitchIndex?: number;
  cursor?: { partIndex: number; measureIndex: number; eventIndex: number } | null;
  /** タイトルを描くか（PDFでは日本語を画像で別に描くので false） */
  drawTitle?: boolean;
  /** ページの高さ。指定すると、システムをページごとに分ける */
  pageHeight?: number;
}

export interface EventHit {
  id: string;
  eventIndex: number;
  x: number;
  /** 当たり判定の左右の範囲 */
  left: number;
  right: number;
  /** 音符の頭のY座標（和音は音ごと） */
  headYs: number[];
}

export interface MeasureHit {
  partIndex: number;
  measureIndex: number;
  x0: number;
  x1: number;
  /** 第1線（いちばん上の線）のY */
  topLineY: number;
  lineSpacing: number;
  clef: Clef;
  events: EventHit[];
  page: number;
}

export interface SystemLayout {
  measures: number[];
  widths: number[];
}

const MARGIN_X = 24;
const PART_SPACING = 110;
const SYSTEM_GAP = 30;
const TITLE_HEIGHT = 90;
const COLOR_SELECTED = '#1565c0';

/** 五線のいちばん上の線にあたる白鍵番号 */
export function topLineDiatonic(clef: Clef): number {
  if (clef === 'bass') return 3 * 7 + 5; // A3
  if (clef === 'alto') return 4 * 7 + 4; // G4
  return 5 * 7 + 3; // F5
}

/** Y座標から五線上の位置（白鍵番号）を求める */
export function diatonicAtY(hit: MeasureHit, y: number): number {
  const steps = Math.round((y - hit.topLineY) / (hit.lineSpacing / 2));
  return topLineDiatonic(hit.clef) - steps;
}

function restKey(clef: Clef) {
  return clef === 'bass' ? 'd/3' : clef === 'alto' ? 'c/4' : 'b/4';
}

interface BuiltMeasure {
  notes: StaveNote[];
  voice: Voice;
  events: MusicEvent[];
  tuplets: Tuplet[];
}

const BEAMABLE = new Set(['8', '16', '32']);

/** 連符の中で、続いている8分以下の音符を1本の連桁にする */
function tupletBeams(events: MusicEvent[], notes: StaveNote[]): Beam[] {
  const beams: Beam[] = [];
  let run: StaveNote[] = [];
  let runId: string | null = null;
  const flush = () => {
    if (run.length > 1) beams.push(new Beam(run, true));
    run = [];
  };
  events.forEach((ev, i) => {
    const id = ev.tuplet?.id ?? null;
    if (id !== runId) { flush(); runId = id; }
    if (id && ev.kind === 'note' && BEAMABLE.has(ev.duration)) run.push(notes[i]);
    else flush();
  });
  flush();
  return beams;
}

/** 連続して同じ連符 id を持つ音をまとめて VexFlow の Tuplet にする（音の長さもここで縮まる） */
function buildTuplets(events: MusicEvent[], notes: StaveNote[]): Tuplet[] {
  const out: Tuplet[] = [];
  for (let i = 0; i < events.length; i++) {
    const t = events[i].tuplet;
    if (!t) continue;
    let e = i + 1;
    while (e < events.length && events[e].tuplet?.id === t.id) e++;
    out.push(new Tuplet(notes.slice(i, e), {
      num_notes: t.actual,
      notes_occupied: t.normal,
      ratioed: false,
    }));
    i = e - 1;
  }
  return out;
}

function buildMeasure(score: Score, partIndex: number, measureIndex: number, opts: RenderOptions): BuiltMeasure {
  const part = score.parts[partIndex];
  const events = part.measures[measureIndex].events;
  const ts = score.timeSignature;
  const accState = new Map<number, number>();
  const notes = events.map((ev) => {
    const selected = ev.id === opts.selectedId;
    let note: StaveNote;
    if (ev.kind === 'rest') {
      const whole = events.length === 1;
      note = new StaveNote({
        keys: [restKey(part.clef)],
        duration: (whole ? 'w' : ev.duration) + 'r',
        dots: whole ? 0 : ev.dots,
        clef: part.clef,
        align_center: whole,
      } as never);
    } else {
      note = new StaveNote({
        keys: ev.pitches.map((p) => `${p.step.toLowerCase()}/${p.octave}`),
        duration: ev.duration,
        dots: ev.dots,
        clef: part.clef,
        auto_stem: true,
      });
      ev.pitches.forEach((p, i) => {
        const di = diatonicIndex(p);
        const expected = accState.has(di) ? accState.get(di)! : keyAlter(score.keyFifths, p.step);
        if (p.alter !== expected) {
          note.addModifier(new Accidental(accidentalSymbol(p.alter)), i);
          accState.set(di, p.alter);
        }
      });
      if (selected) {
        const pi = Math.min(opts.selectedPitchIndex ?? 0, ev.pitches.length - 1);
        if (ev.pitches.length === 1) note.setStyle({ fillStyle: COLOR_SELECTED, strokeStyle: COLOR_SELECTED });
        else note.setKeyStyle(pi, { fillStyle: COLOR_SELECTED, strokeStyle: COLOR_SELECTED });
      }
    }
    if (ev.dots && !(ev.kind === 'rest' && events.length === 1)) Dot.buildAndAttach([note], { all: true });
    if (selected && ev.kind === 'rest') note.setStyle({ fillStyle: COLOR_SELECTED, strokeStyle: COLOR_SELECTED });
    return note;
  });
  const tuplets = buildTuplets(events, notes);
  const voice = new Voice({ num_beats: ts.beats, beat_value: ts.beatType }).setMode(Voice.Mode.SOFT);
  voice.addTickables(notes);
  return { notes, voice, events, tuplets };
}

/** 小節ごとの必要な幅（音符部分のみ） */
function measureContentWidth(score: Score, measureIndex: number, opts: RenderOptions): number {
  const voices = score.parts.map((_, p) => buildMeasure(score, p, measureIndex, opts).voice);
  const f = new Formatter();
  voices.forEach((v) => f.joinVoices([v]));
  const min = f.preCalculateMinTotalWidth(voices);
  return Math.max(70, min * 1.5 + 30);
}

function startModifiersWidth(score: Score, firstMeasure: boolean): number {
  let w = 0;
  for (const part of score.parts) {
    const s = new Stave(0, 0, 400);
    s.addClef(part.clef).addKeySignature(keyName(score.keyFifths));
    if (firstMeasure) s.addTimeSignature(`${score.timeSignature.beats}/${score.timeSignature.beatType}`);
    w = Math.max(w, s.getNoteStartX() - s.getX());
  }
  return w + 10;
}

export function layoutSystems(score: Score, opts: RenderOptions): SystemLayout[] {
  const available = opts.width - MARGIN_X * 2;
  const n = score.parts[0].measures.length;
  const content = Array.from({ length: n }, (_, i) => measureContentWidth(score, i, opts));
  const systems: SystemLayout[] = [];
  let cur: SystemLayout = { measures: [], widths: [] };
  let used = 0;
  for (let i = 0; i < n; i++) {
    const head = cur.measures.length === 0 ? startModifiersWidth(score, i === 0) : 0;
    const w = content[i] + head;
    if (cur.measures.length && used + w > available) {
      systems.push(cur);
      cur = { measures: [], widths: [] };
      used = 0;
      i--;
      continue;
    }
    cur.measures.push(i);
    cur.widths.push(w);
    used += w;
  }
  if (cur.measures.length) systems.push(cur);
  // 横幅いっぱいに広げる（最後の段は、半分以上埋まっているときだけ）
  systems.forEach((s, si) => {
    const total = s.widths.reduce((a, b) => a + b, 0);
    const last = si === systems.length - 1;
    if (last && total < available * 0.6) return;
    const head = startModifiersWidth(score, s.measures[0] === 0);
    const extra = (available - total) / s.widths.length;
    s.widths = s.widths.map((w, k) => (k === 0 ? Math.max(head + 40, w + extra) : w + extra));
    const sum = s.widths.reduce((a, b) => a + b, 0);
    s.widths[s.widths.length - 1] += available - sum;
  });
  return systems;
}

export function systemHeight(score: Score) {
  return score.parts.length * PART_SPACING + SYSTEM_GAP;
}

export interface Page {
  systems: SystemLayout[];
  /** 最初のページだけタイトルの分を空ける */
  first: boolean;
}

export function paginate(score: Score, systems: SystemLayout[], pageHeight: number, topMargin = 40): Page[] {
  const h = systemHeight(score);
  const pages: Page[] = [];
  let cur: Page = { systems: [], first: true };
  let y = topMargin + TITLE_HEIGHT;
  for (const s of systems) {
    if (cur.systems.length && y + h > pageHeight - topMargin) {
      pages.push(cur);
      cur = { systems: [], first: false };
      y = topMargin;
    }
    cur.systems.push(s);
    y += h;
  }
  pages.push(cur);
  return pages;
}

/** テンポ表記の位置（タップで変更するため） */
export interface TempoHit {
  measure: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RenderResult {
  hits: MeasureHit[];
  tempoHits: TempoHit[];
  height: number;
}

type Ctx = ReturnType<Renderer['getContext']>;

/** 「♩ = 120」を描く。♩は図形で描く（PDFの標準フォントに♩がないため）。y は文字のベースライン */
function drawTempo(ctx: Ctx, x: number, y: number, tempo: number): TempoHit & { measure: -1 } {
  ctx.save();
  ctx.setFillStyle('#000');
  ctx.setStrokeStyle('#000');
  ctx.beginPath();
  // 符頭（少し傾いた楕円の代わりに、横長の円を2つ重ねる）
  ctx.arc(x + 4, y - 3, 3.6, 0, Math.PI * 2, false);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + 5.2, y - 3.6, 3.2, 0, Math.PI * 2, false);
  ctx.fill();
  ctx.setLineWidth(1.2);
  ctx.beginPath();
  ctx.moveTo(x + 8, y - 4);
  ctx.lineTo(x + 8, y - 19);
  ctx.stroke();
  ctx.setFont('serif', 13, 'bold');
  const label = `= ${tempo}`;
  ctx.fillText(label, x + 13, y);
  const w = 13 + ctx.measureText(label).width;
  ctx.restore();
  return { measure: -1, x: x - 6, y: y - 24, w: w + 12, h: 32 };
}

/** 1ページ（画面ではすべて）を el の中に SVG で描く */
export function renderPage(el: HTMLElement, score: Score, page: Page, opts: RenderOptions, pageNo = 0, topMargin = 20): RenderResult {
  el.innerHTML = '';
  const scale = opts.scale ?? 1;
  const sysH = systemHeight(score);
  const contentTop = topMargin + (page.first ? TITLE_HEIGHT : 0);
  const height = opts.pageHeight ?? contentTop + page.systems.length * sysH + 20;
  const renderer = new Renderer(el as HTMLDivElement, Renderer.Backends.SVG);
  renderer.resize(opts.width * scale, height * scale);
  const ctx = renderer.getContext();
  ctx.scale(scale, scale);
  const hits: MeasureHit[] = [];
  const tempoHits: TempoHit[] = [];

  if (page.first && opts.drawTitle !== false) {
    ctx.save();
    ctx.setFont('serif', 26, 'bold');
    const tw = ctx.measureText(score.title).width;
    ctx.fillText(score.title, (opts.width - tw) / 2, topMargin + 40);
    if (score.composer) {
      ctx.setFont('serif', 14, 'normal');
      const cw = ctx.measureText(score.composer).width;
      ctx.fillText(score.composer, opts.width - MARGIN_X - cw, topMargin + 72);
    }
    ctx.restore();
    tempoHits.push({ ...drawTempo(ctx, MARGIN_X, topMargin + 72, score.tempo), measure: 0 });
  }

  const allNotes = new Map<string, { note: StaveNote; system: number }>();
  const ties: { from: string; to: string }[] = [];

  page.systems.forEach((sys, si) => {
    const sysY = contentTop + si * sysH;
    let x = MARGIN_X;
    sys.measures.forEach((mi, k) => {
      const w = sys.widths[k];
      const staves = score.parts.map((part, pi) => {
        const st = new Stave(x, sysY + pi * PART_SPACING, w);
        if (k === 0) st.addClef(part.clef).addKeySignature(keyName(score.keyFifths));
        if (mi === 0) st.addTimeSignature(`${score.timeSignature.beats}/${score.timeSignature.beatType}`);
        if (mi === score.parts[0].measures.length - 1) st.setEndBarType(3 /* END */);
        if (k === 0 && mi > 0) st.setMeasure(mi + 1);
        return st;
      });
      const noteStart = Math.max(...staves.map((s) => s.getNoteStartX()));
      staves.forEach((s) => s.setNoteStartX(noteStart));
      staves.forEach((s) => s.setContext(ctx).draw());
      const mark = mi > 0 ? tempoMarkAt(score, mi) : null;
      if (mark !== null) {
        const tx = k === 0 ? noteStart - 4 : x + 6;
        tempoHits.push({ ...drawTempo(ctx, tx, staves[0].getYForLine(0) - 22, mark), measure: mi });
      }

      const built = score.parts.map((_, pi) => buildMeasure(score, pi, mi, opts));
      const f = new Formatter();
      built.forEach((b) => f.joinVoices([b.voice]));
      f.format(built.map((b) => b.voice), staves[0].getNoteEndX() - noteStart - 14);

      built.forEach((b, pi) => {
        const stave = staves[pi];
        // 連符の音は連符ごとに連桁でつなぎ、それ以外は拍ごとに自動でつなぐ
        const beams = Beam.generateBeams(b.notes.filter((_, i) => b.events[i].kind === 'note' && !b.events[i].tuplet), {
          groups: Beam.getDefaultBeamGroups(`${score.timeSignature.beats}/${score.timeSignature.beatType}`),
        });
        beams.push(...tupletBeams(b.events, b.notes));
        b.voice.draw(ctx, stave);
        beams.forEach((bm) => bm.setContext(ctx).draw());
        b.tuplets.forEach((t) => t.setContext(ctx).draw());

        const evHits: EventHit[] = b.notes.map((n, i) => {
          const nx = n.getAbsoluteX();
          return { id: b.events[i].id, eventIndex: i, x: nx, left: nx, right: nx, headYs: n.getYs() };
        });
        evHits.forEach((h, i) => {
          h.left = i === 0 ? stave.getX() : (evHits[i - 1].x + h.x) / 2 + 4;
          h.right = i === evHits.length - 1 ? stave.getX() + stave.getWidth() : (h.x + evHits[i + 1].x) / 2 + 4;
        });
        const hit: MeasureHit = {
          partIndex: pi,
          measureIndex: mi,
          x0: stave.getX(),
          x1: stave.getX() + stave.getWidth(),
          topLineY: stave.getYForLine(0),
          lineSpacing: stave.getSpacingBetweenLines(),
          clef: score.parts[pi].clef,
          events: evHits,
          page: pageNo,
        };
        hits.push(hit);

        b.events.forEach((ev, i) => {
          allNotes.set(ev.id, { note: b.notes[i], system: si });
          if (ev.kind === 'note' && ev.tie) {
            const next = nextEvent(score, pi, mi, i);
            if (next && next.kind === 'note') ties.push({ from: ev.id, to: next.id });
          }
        });

        // 入力位置（カーソル）
        const c = opts.cursor;
        if (c && c.partIndex === pi && c.measureIndex === mi) {
          const eh = evHits[Math.min(c.eventIndex, evHits.length - 1)];
          if (eh) {
            ctx.save();
            ctx.setFillStyle('rgba(21,101,192,0.15)');
            ctx.fillRect(eh.x - 6, hit.topLineY - 22, 26, hit.lineSpacing * 4 + 44);
            ctx.restore();
          }
        }
      });

      if (staves.length > 1) {
        const top = staves[0];
        const bottom = staves[staves.length - 1];
        new StaveConnector(top, bottom).setType('singleRight').setContext(ctx).draw();
        if (k === 0) {
          new StaveConnector(top, bottom).setType('singleLeft').setContext(ctx).draw();
          const brace = score.parts.length === 2 && score.parts[0].clef === 'treble' && score.parts[1].clef === 'bass';
          new StaveConnector(top, bottom).setType(brace ? 'brace' : 'bracket').setContext(ctx).draw();
        }
      }
      x += w;
    });
  });

  for (const t of ties) {
    const a = allNotes.get(t.from);
    const b = allNotes.get(t.to);
    if (!a) continue;
    const fromEv = findById(score, t.from);
    const toEv = findById(score, t.to);
    if (!fromEv || fromEv.kind !== 'note' || !toEv || toEv.kind !== 'note') continue;
    const first: number[] = [];
    const last: number[] = [];
    fromEv.pitches.forEach((p, i) => {
      const j = toEv.pitches.findIndex((q) => q.step === p.step && q.octave === p.octave);
      if (j >= 0) { first.push(i); last.push(j); }
    });
    if (!first.length) continue;
    if (b && b.system === a.system) {
      new StaveTie({ first_note: a.note, last_note: b.note, first_indices: first, last_indices: last }).setContext(ctx).draw();
    } else {
      new StaveTie({ first_note: a.note, last_note: null, first_indices: first, last_indices: first }).setContext(ctx).draw();
      if (b) new StaveTie({ first_note: null, last_note: b.note, first_indices: last, last_indices: last }).setContext(ctx).draw();
    }
  }

  return { hits, tempoHits, height };
}

function nextEvent(score: Score, pi: number, mi: number, ei: number): MusicEvent | undefined {
  const ms = score.parts[pi].measures;
  if (ei + 1 < ms[mi].events.length) return ms[mi].events[ei + 1];
  return ms[mi + 1]?.events[0];
}

function findById(score: Score, id: string): MusicEvent | undefined {
  for (const p of score.parts) for (const m of p.measures) for (const e of m.events) if (e.id === id) return e;
  return undefined;
}

/** 画面用：全体を1枚の長いSVGに描く */
export function renderScore(el: HTMLElement, score: Score, opts: RenderOptions): RenderResult {
  const systems = layoutSystems(score, opts);
  return renderPage(el, score, { systems, first: true }, opts);
}

export { measureCapacity };
