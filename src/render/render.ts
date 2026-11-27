/**
 * 楽譜を VexFlow で SVG に描く。画面表示とPDF書き出しで同じ処理を使う。
 * 描いた音符の位置（HitMap）を返し、タップ・ペン入力の当たり判定に使う。
 */
import {
  Accidental, Beam, Dot, Formatter, Renderer, Stave, StaveConnector, StaveNote, StaveTie, Tuplet, Voice, VoltaType,
} from 'vexflow/bravura';
import { diatonicIndex, keyAlter, keyName, accidentalSymbol } from '../model/pitch';
import {
  Clef, MusicEvent, Score, capacityAt, clefAt, clefChangeAt, eventTicks, voiceEvents, keyAt, keyChangeAt, measureAttrsAt, measureCapacity, tempoMarkAt,
  timeSigAt, timeSigChangeAt,
} from '../model/score';
import {
  MeasureStart, SystemTextEntry, TextFocus, TextHit, TextItem, addTextSpacers, drawSystemTexts, flushHyphens,
  newTextState, partSpacing, rehearsalWidth,
} from './texts';
import { SystemBox, attachArticulations, drawMarks } from './marks';
import { attachGraces, drawFlowMarks } from './notation';
import { ottavaAboveMeasures } from '../model/marks';

/** 8va の線の分、上の記号を上げる高さ */
const OTTAVA_LIFT = 18;

// VexFlow の小節線の種類（Barline.type）
const BAR_SINGLE = 1;
const BAR_DOUBLE = 2;
const BAR_END = 3;
const BAR_REPEAT_BEGIN = 4;
const BAR_REPEAT_END = 5;

export interface RenderOptions {
  /** 描画に使う論理幅（px） */
  width: number;
  /** 拡大率 */
  scale?: number;
  selectedId?: string | null;
  selectedPitchIndex?: number;
  /** 範囲選択に入っている音符・休符（範囲がなければ null） */
  rangeIds?: Set<string> | null;
  cursor?: { partIndex: number; measureIndex: number; eventIndex: number; voice?: number } | null;
  /** タイトルを描くか（PDFでは日本語を画像で別に描くので false） */
  drawTitle?: boolean;
  /** ページの高さ。指定すると、システムをページごとに分ける */
  pageHeight?: number;
  /** 入力中の歌詞・コードネームなど（薄い青で示す） */
  textFocus?: TextFocus | null;
  /** 指定すると、歌詞などの文字は描かずにここへ渡す（PDFで日本語を画像にして載せるため） */
  textSink?: (item: TextItem) => void;
}

export interface EventHit {
  id: string;
  eventIndex: number;
  /** 0=声部1、1=声部2 */
  voice: number;
  /** 小節の頭からのティック */
  tick: number;
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
  /** 声部1の音符・休符 */
  events: EventHit[];
  /** 声部ごとの音符・休符（[0] は events と同じ。声部2がない小節は [1] が空） */
  voices: EventHit[][];
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
/** 声部2の入力位置の色（MuseScore と同じく緑系） */
const COLOR_VOICE2 = 'rgba(46,125,50,0.18)';

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

function restKey(clef: Clef, shift = 0) {
  const mid = topLineDiatonic(clef) - 4 + shift;
  const step = 'cdefgab'[((mid % 7) + 7) % 7];
  return `${step}/${Math.floor(mid / 7)}`;
}

interface BuiltMeasure {
  notes: StaveNote[];
  voice: Voice;
  events: MusicEvent[];
  /** 0=声部1、1=声部2 */
  voiceIndex: number;
  ticks: number[];
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

/**
 * 臨時記号を付ける音を決める。声部をまたいで、小節の中で時間順に「その段で直前に付いた記号」を覚える。
 * 戻り値は「声部:音の番号:和音の中の番号」の集合。
 */
function accidentalsFor(key: number, lists: MusicEvent[][]): Set<string> {
  const items: { t: number; v: number; i: number; ev: MusicEvent }[] = [];
  lists.forEach((evs, v) => {
    let t = 0;
    evs.forEach((ev, i) => { items.push({ t, v, i, ev }); t += eventTicks(ev); });
  });
  items.sort((a, b) => a.t - b.t || a.v - b.v);
  const state = new Map<number, number>();
  const out = new Set<string>();
  for (const { v, i, ev } of items) {
    if (ev.kind !== 'note') continue;
    const now = new Map<number, number>();
    ev.pitches.forEach((p, k) => {
      const di = diatonicIndex(p);
      const expected = state.has(di) ? state.get(di)! : keyAlter(key, p.step);
      if (p.alter !== expected || (now.has(di) && now.get(di) !== p.alter)) out.add(`${v}:${i}:${k}`);
      now.set(di, p.alter);
    });
    for (const [di, a] of now) state.set(di, a);
  }
  return out;
}

/** 小節の各声部を作る。声部2がある小節では、声部1の符尾は上、声部2は下にし、休符も上下に離す */
function buildMeasure(score: Score, partIndex: number, measureIndex: number, opts: RenderOptions): BuiltMeasure[] {
  const part = score.parts[partIndex];
  const m = part.measures[measureIndex];
  const lists = m.voice2 ? [m.events, m.voice2] : [m.events];
  const multi = lists.length > 1;
  const ts = timeSigAt(score, measureIndex);
  const clef = clefAt(part, measureIndex);
  const key = keyAt(score, measureIndex);
  const fullMeasure = capacityAt(score, measureIndex) >= measureCapacity(ts);
  const acc = accidentalsFor(key, lists);
  return lists.map((events, v) => {
    const stem = !multi ? undefined : v === 0 ? 1 : -1;
    const ticks: number[] = [];
    let t = 0;
    const notes = events.map((ev, i) => {
      ticks.push(t);
      t += eventTicks(ev);
      const inRange = !!opts.rangeIds?.has(ev.id);
      const selected = !inRange && ev.id === opts.selectedId;
      let note: StaveNote;
      if (ev.kind === 'rest') {
        // 1小節まるごとの休符は全休符の形で小節の真ん中に（弱起の小節は本当の長さで描く）
        const whole = events.length === 1 && fullMeasure;
        note = new StaveNote({
          keys: [restKey(clef, multi ? (v === 0 ? 4 : -4) : 0)],
          duration: (whole ? 'w' : ev.duration) + 'r',
          dots: whole ? 0 : ev.dots,
          clef,
          align_center: whole,
        } as never);
      } else {
        note = new StaveNote({
          keys: ev.pitches.map((p) => `${p.step.toLowerCase()}/${p.octave}`),
          duration: ev.duration,
          dots: ev.dots,
          clef,
          ...(stem ? { stem_direction: stem } : { auto_stem: true }),
        });
        ev.pitches.forEach((p, k) => {
          if (acc.has(`${v}:${i}:${k}`)) note.addModifier(new Accidental(accidentalSymbol(p.alter)), k);
        });
        attachGraces(note, ev, clef, key, inRange || selected ? COLOR_SELECTED : undefined);
        if (selected) {
          const pi = Math.min(opts.selectedPitchIndex ?? 0, ev.pitches.length - 1);
          if (ev.pitches.length === 1) note.setStyle({ fillStyle: COLOR_SELECTED, strokeStyle: COLOR_SELECTED });
          else note.setKeyStyle(pi, { fillStyle: COLOR_SELECTED, strokeStyle: COLOR_SELECTED });
        }
      }
      if (ev.dots && !(ev.kind === 'rest' && events.length === 1 && fullMeasure)) Dot.buildAndAttach([note], { all: true });
      addTextSpacers(note, ev);
      if (inRange) note.setStyle({ fillStyle: COLOR_SELECTED, strokeStyle: COLOR_SELECTED });
      if (selected && ev.kind === 'rest') note.setStyle({ fillStyle: COLOR_SELECTED, strokeStyle: COLOR_SELECTED });
      attachArticulations(note, ev);
      return note;
    });
    const tuplets = buildTuplets(events, notes);
    const voice = new Voice({ num_beats: ts.beats, beat_value: ts.beatType }).setMode(Voice.Mode.SOFT);
    voice.addTickables(notes);
    return { notes, voice, events, tuplets, voiceIndex: v, ticks };
  });
}

const tsSpec = (score: Score, mi: number) => {
  const ts = timeSigAt(score, mi);
  return `${ts.beats}/${ts.beatType}`;
};

/** 小節の頭に付ける記号（段の頭か途中かで変わる）を stave に足す */
function addStartModifiers(st: Stave, score: Score, pi: number, mi: number, systemStart: boolean) {
  const part = score.parts[pi];
  if (systemStart) {
    st.addClef(clefAt(part, mi)).addKeySignature(keyName(keyAt(score, mi)));
  } else {
    // 段の途中の音部記号の変更は小さく書く
    const cc = clefChangeAt(part, mi);
    if (cc) st.addClef(cc, 'small');
    const kc = keyChangeAt(score, mi);
    if (kc !== null) st.addKeySignature(keyName(kc), keyName(keyAt(score, mi - 1)));
  }
  if (mi === 0 || timeSigChangeAt(score, mi)) st.addTimeSignature(tsSpec(score, mi));
  if (measureAttrsAt(score, mi)?.repeatStart) st.setBegBarType(BAR_REPEAT_BEGIN);
}

/** 小節の頭の記号の幅 */
function modifiersWidth(score: Score, mi: number, systemStart: boolean): number {
  let w = 0;
  for (let pi = 0; pi < score.parts.length; pi++) {
    const s = new Stave(0, 0, 400);
    addStartModifiers(s, score, pi, mi, systemStart);
    w = Math.max(w, s.getNoteStartX() - s.getX());
  }
  return w + 10;
}

/** 小節ごとの必要な幅（音符部分のみ） */
function measureContentWidth(score: Score, measureIndex: number, opts: RenderOptions): number {
  const perPart = score.parts.map((_, p) => buildMeasure(score, p, measureIndex, opts).map((b) => b.voice));
  const f = new Formatter();
  perPart.forEach((vs) => f.joinVoices(vs));
  const min = f.preCalculateMinTotalWidth(perPart.flat());
  return Math.max(70, min * 1.5 + 30);
}

function startModifiersWidth(score: Score, mi: number): number {
  return modifiersWidth(score, mi, true);
}

/** 段の途中の小節で、調号・拍子の変更やリピート開始のために増える幅 */
function midModifiersWidth(score: Score, mi: number): number {
  const a = measureAttrsAt(score, mi);
  const clefChange = score.parts.some((p) => clefChangeAt(p, mi));
  if (!clefChange && (!a || (keyChangeAt(score, mi) === null && !timeSigChangeAt(score, mi) && !a.repeatStart))) return 0;
  return modifiersWidth(score, mi, false);
}

export function layoutSystems(score: Score, opts: RenderOptions): SystemLayout[] {
  const available = opts.width - MARGIN_X * 2;
  const n = score.parts[0].measures.length;
  const content = Array.from({ length: n }, (_, i) => measureContentWidth(score, i, opts));
  const systems: SystemLayout[] = [];
  let cur: SystemLayout = { measures: [], widths: [] };
  let used = 0;
  for (let i = 0; i < n; i++) {
    const head = cur.measures.length === 0 ? startModifiersWidth(score, i) : midModifiersWidth(score, i);
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
    const head = startModifiersWidth(score, s.measures[0]);
    const extra = (available - total) / s.widths.length;
    s.widths = s.widths.map((w, k) => (k === 0 ? Math.max(head + 40, w + extra) : w + extra));
    const sum = s.widths.reduce((a, b) => a + b, 0);
    s.widths[s.widths.length - 1] += available - sum;
  });
  return systems;
}

/** 段の中での各パートの五線のY（段の上端から）。歌詞・コードネームがあるパートは間を広げる */
export function partOffsets(score: Score): number[] {
  const sp = partSpacing(score);
  const out: number[] = [];
  let y = 0;
  sp.forEach((s) => {
    y += s.above;
    out.push(y);
    y += PART_SPACING + s.below;
  });
  return out;
}

export function systemHeight(score: Score) {
  const sp = partSpacing(score);
  return sp.reduce((h, s) => h + PART_SPACING + s.above + s.below, 0) + SYSTEM_GAP;
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
  /** 歌詞・コードネーム・文字・練習番号の位置（タップで直すため） */
  textHits: TextHit[];
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
  const textHits: TextHit[] = [];
  const spacing = partSpacing(score);
  const offsets = partOffsets(score);
  const textState = newTextState();
  // 8va の線がかかる小節では、テンポ表記・セーニョなどを線の上へ上げる
  const ottavaLift = ottavaAboveMeasures(score);

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
  }
  // テンポはPDFでも楽譜と同じ図形で描く（タイトルは画像で載せるが、♩はフォントによって欠けるため）
  if (page.first) tempoHits.push({ ...drawTempo(ctx, MARGIN_X, topMargin + 72, score.tempo), measure: 0 });

  const allNotes = new Map<string, { note: StaveNote; system: number }>();
  const ties: { from: string; to: string }[] = [];
  const boxes: SystemBox[] = [];
  const partOf = new Map<string, number>();

  page.systems.forEach((sys, si) => {
    const sysY = contentTop + si * sysH;
    let x = MARGIN_X;
    const textEntries: SystemTextEntry[] = [];
    const measureStarts: MeasureStart[] = [];
    sys.measures.forEach((mi, k) => {
      const w = sys.widths[k];
      const attrs = measureAttrsAt(score, mi);
      const last = mi === score.parts[0].measures.length - 1;
      const staves = score.parts.map((_part, pi) => {
        const st = new Stave(x, sysY + offsets[pi], w);
        addStartModifiers(st, score, pi, mi, k === 0);
        if (attrs?.repeatEnd) st.setEndBarType(BAR_REPEAT_END);
        else if (last) st.setEndBarType(BAR_END);
        // Fine と D.C./D.S. の小節の終わりは複縦線
        else if (attrs?.fine || attrs?.jump) st.setEndBarType(BAR_DOUBLE);
        // 次の小節で調号・拍子が変わるときは複縦線
        else if (keyChangeAt(score, mi + 1) !== null || timeSigChangeAt(score, mi + 1)) st.setEndBarType(BAR_DOUBLE);
        else st.setEndBarType(BAR_SINGLE);
        // 小節番号：弱起の小節は 0 として数える（表示はしない）
        const num = mi + (score.pickup ? 0 : 1);
        if (k === 0 && num > 1) st.setMeasure(num);
        return st;
      });
      const volta = voltaFor(score, mi);
      if (volta) staves[0].setVoltaType(volta.type, volta.label, 0);
      const noteStart = Math.max(...staves.map((s) => s.getNoteStartX()));
      staves.forEach((s) => s.setNoteStartX(noteStart));
      if (k === 0) {
        boxes[si] = {
          x0: noteStart - 4,
          x1: x + sys.widths.reduce((a, b) => a + b, 0) - 4,
          tops: staves.map((s) => s.getYForLine(0)),
          bottoms: staves.map((s) => s.getYForLine(4)),
        };
      }
      staves.forEach((s) => s.setContext(ctx).draw());
      const mark = mi > 0 ? tempoMarkAt(score, mi) : null;
      measureStarts.push({ measureIndex: mi, x: k === 0 ? noteStart - 4 : x + 6, topLineY: staves[0].getYForLine(0) });
      if (mark !== null) {
        let tx = k === 0 ? noteStart - 4 : x + 6;
        const rh = score.parts[0].measures[mi].rehearsal;
        if (rh) tx += rehearsalWidth(rh) + 6;
        tempoHits.push({ ...drawTempo(ctx, tx, staves[0].getYForLine(0) - 22 - (ottavaLift.has(mi) ? OTTAVA_LIFT : 0), mark), measure: mi });
      }
      // セーニョ・コーダは練習番号とテンポ表記の後ろに。D.S. などは小節の右端に
      {
        let fx = k === 0 ? noteStart - 4 : x + 6;
        const rh = score.parts[0].measures[mi].rehearsal;
        if (rh) fx += rehearsalWidth(rh) + 6;
        const th = mark !== null ? tempoHits[tempoHits.length - 1] : null;
        if (th) fx = th.x + th.w + 4;
        drawFlowMarks(ctx, attrs, staves[0], fx, ottavaLift.has(mi) ? OTTAVA_LIFT : 0);
      }

      const built = score.parts.map((_, pi) => buildMeasure(score, pi, mi, opts));
      const f = new Formatter();
      built.forEach((vs) => f.joinVoices(vs.map((b) => b.voice)));
      f.format(built.flatMap((vs) => vs.map((b) => b.voice)), staves[0].getNoteEndX() - noteStart - 14);

      built.forEach((vs, pi) => {
        const stave = staves[pi];
        const voiceHits: EventHit[][] = [[], []];
        for (const b of vs) {
          const multi = vs.length > 1;
          // 連符の音は連符ごとに連桁でつなぎ、それ以外は拍ごとに自動でつなぐ
          const beams = Beam.generateBeams(b.notes.filter((_, i) => b.events[i].kind === 'note' && !b.events[i].tuplet), {
            groups: Beam.getDefaultBeamGroups(tsSpec(score, mi)),
            ...(multi ? { maintain_stem_directions: true } : {}),
          });
          beams.push(...tupletBeams(b.events, b.notes));
          b.voice.draw(ctx, stave);
          beams.forEach((bm) => bm.setContext(ctx).draw());
          b.tuplets.forEach((t) => t.setContext(ctx).draw());
          const evHits: EventHit[] = b.notes.map((n, i) => {
            const nx = n.getAbsoluteX();
            return {
              id: b.events[i].id, eventIndex: i, voice: b.voiceIndex, tick: b.ticks[i],
              x: nx, left: nx, right: nx, headYs: n.getYs(),
            };
          });
          evHits.forEach((h, i) => {
            h.left = i === 0 ? stave.getX() : (evHits[i - 1].x + h.x) / 2 + 4;
            h.right = i === evHits.length - 1 ? stave.getX() + stave.getWidth() : (h.x + evHits[i + 1].x) / 2 + 4;
          });
          voiceHits[b.voiceIndex] = evHits;
        }
        const evHits = voiceHits[0];
        const hit: MeasureHit = {
          partIndex: pi,
          measureIndex: mi,
          x0: stave.getX(),
          x1: stave.getX() + stave.getWidth(),
          topLineY: stave.getYForLine(0),
          lineSpacing: stave.getSpacingBetweenLines(),
          clef: clefAt(score.parts[pi], mi),
          events: evHits,
          voices: voiceHits,
          page: pageNo,
        };
        hits.push(hit);

        for (const b of vs) {
          b.events.forEach((ev, i) => {
            allNotes.set(ev.id, { note: b.notes[i], system: si });
            textEntries.push({
              partIndex: pi, measureIndex: mi, voice: b.voiceIndex, ev, note: b.notes[i],
              topLineY: hit.topLineY, bottomLineY: hit.topLineY + hit.lineSpacing * 4,
            });
            partOf.set(ev.id, pi);
            if (ev.kind === 'note' && ev.tie) {
              const next = nextEvent(score, pi, mi, i, b.voiceIndex);
              if (next && next.kind === 'note') ties.push({ from: ev.id, to: next.id });
            }
          });
        }

        // 範囲選択の帯
        // 範囲は声部2だけのこともある（声部2の1音のコピー・貼り付け）ので、両方の声部から帯の端を決める
        const inRange = voiceHits.flat().filter((h) => opts.rangeIds?.has(h.id));
        if (inRange.length) {
          const l = Math.min(...inRange.map((h) => Math.max(h.left, h.x - 12)));
          const r = Math.max(...inRange.map((h) => h.right));
          ctx.save();
          ctx.setFillStyle('rgba(21,101,192,0.12)');
          ctx.fillRect(l, hit.topLineY - 14, r - l, hit.lineSpacing * 4 + 28);
          ctx.restore();
        }

        // 入力位置（カーソル）。声部2は緑
        const c = opts.cursor;
        if (c && c.partIndex === pi && c.measureIndex === mi) {
          const cv = c.voice ?? 0;
          const list = voiceHits[cv].length ? voiceHits[cv] : evHits;
          const eh = list[Math.min(c.eventIndex, list.length - 1)];
          if (eh) {
            ctx.save();
            ctx.setFillStyle(cv ? COLOR_VOICE2 : 'rgba(21,101,192,0.15)');
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
    textHits.push(...drawSystemTexts(ctx, score, textEntries, measureStarts, si, textState, {
      sink: opts.textSink, focus: opts.textFocus, spacing,
    }));
  });
  flushHyphens(ctx, textState, opts.textSink);

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

  drawMarks(ctx, score, allNotes, boxes, partOf);

  return { hits, tempoHits, textHits, height };
}

/** 番号付きカッコの描き方。続きの小節は、番号を付けずに線だけ続ける */
function voltaFor(score: Score, mi: number): { type: number; label: string } | null {
  const a = measureAttrsAt(score, mi);
  if (!a?.volta?.length) return null;
  const key = a.volta.join(',');
  const prevSame = measureAttrsAt(score, mi - 1)?.volta?.join(',') === key;
  const nextSame = measureAttrsAt(score, mi + 1)?.volta?.join(',') === key && mi + 1 < score.parts[0].measures.length;
  // 最後のカッコ（戻らない方）は右端を閉じない
  const closeEnd = !nextSame && !!a.repeatEnd;
  const begin = !prevSame;
  const label = a.volta.map((n) => `${n}.`).join(' ');
  if (begin) return { type: closeEnd ? VoltaType.BEGIN_END : VoltaType.BEGIN, label };
  return { type: closeEnd ? VoltaType.END : VoltaType.MID, label: '' };
}

function nextEvent(score: Score, pi: number, mi: number, ei: number, voice = 0): MusicEvent | undefined {
  const ms = score.parts[pi].measures;
  const cur = voiceEvents(ms[mi], voice);
  if (ei + 1 < cur.length) return cur[ei + 1];
  return ms[mi + 1] ? voiceEvents(ms[mi + 1], voice)[0] : undefined;
}

function findById(score: Score, id: string): MusicEvent | undefined {
  for (const p of score.parts)
    for (const m of p.measures)
      for (const e of m.voice2 ? [...m.events, ...m.voice2] : m.events) if (e.id === id) return e;
  return undefined;
}

/** 画面用：全体を1枚の長いSVGに描く */
export function renderScore(el: HTMLElement, score: Score, opts: RenderOptions): RenderResult {
  const systems = layoutSystems(score, opts);
  return renderPage(el, score, { systems, first: true }, opts);
}

export { measureCapacity };
