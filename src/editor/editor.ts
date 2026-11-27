/**
 * 編集操作の窓口。画面のボタン・キーボード・（今後の）iPad鍵盤や手書き認識は、すべてここを通して楽譜を変える。
 * 各操作の前にスナップショットを取り、元に戻す／やり直しに使う。
 */
import { DurationType, decompose, ticksOf } from '../model/duration';
import {
  Pitch, comparePitch, diatonicIndex, fromDiatonic, fromMidi, keyAlter, samePitch, STEPS, Step,
} from '../model/pitch';
import {
  Clef, copyTexts, EventLocation, Instrument, Measure, MusicEvent, NoteEvent, Score, createMeasure, createPart, equalizeMeasureCounts,
  beatTicks, ensureVoice, eventAt, eventTicks, findEvent, makeNote, makeRest, makeTupletGroup, measureCapacity, measureEvents,
  measureTicks, normalizeMeasure, overwriteAt, overwriteInTuplet, restsFor, splitRestAt, tickOfIndex, TimeSignature, tupletRange,
  voiceEvents, capacityAt, keyAt, measureAttrsAt, measureStartTick, reflowMeasures, shiftMeasureMarks, timeSigAt, updateMeasureAttrs,
  GraceNote, JumpKind, clefAt,
} from '../model/score';
import { Interval, transposeKey, transposePitch } from '../model/transpose';
import { Articulation, Dynamic, SpannerKind } from '../model/score';
import { setDynamicOn, toggleArticulationOn, toggleSpannerAt } from '../model/marks';
import {
  Clip, RangeSel, clearRange, eventSpan, extractRange, pasteClip, rangeEnds, rangeEventIds, rangeNotes,
} from './range';
import { lyricOf, setLyricOn } from '../model/texts';

/** 移調する範囲。all=楽譜全体（調号も変える）、part=1つの譜表、ids=指定の音符だけ */
export type TransposeScope = { kind: 'all' } | { kind: 'part'; partIndex: number } | { kind: 'ids'; ids: string[] };

/** select=選んで直す、input=タップ・鍵盤で入れる、pen=五線に手書き */
export type Mode = 'select' | 'input' | 'pen';

export interface Cursor {
  partIndex: number;
  measureIndex: number;
  eventIndex: number;
  /** 入力する声部。0=声部1（省略時）、1=声部2 */
  voice?: number;
}

type Listener = (reason: 'score' | 'view') => void;

const MAX_HISTORY = 200;

export class Editor {
  score: Score;
  mode: Mode = 'input';
  inputDuration: DurationType = 'q';
  inputDots = 0;
  /** 入力した音を、選択中の音符に和音として重ねる */
  chordMode = false;
  cursor: Cursor = { partIndex: 0, measureIndex: 0, eventIndex: 0 };
  selectedId: string | null = null;
  /** 和音の中で操作対象にする音の番号 */
  selectedPitchIndex = 0;
  /** 範囲選択（なければ null）。あるときは selectedId に範囲の最後の音が入る */
  range: RangeSel | null = null;
  /** 範囲を広げるときの起点 */
  private rangeAnchor: RangeSel | null = null;
  /** コピーした内容（楽譜をまたいで使える） */
  clipboard: Clip | null = null;

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners: Listener[] = [];
  private coalesceToken: string | null = null;

  constructor(score: Score) {
    this.score = score;
  }

  onChange(fn: Listener) {
    this.listeners.push(fn);
  }

  private emit(reason: 'score' | 'view') {
    for (const fn of this.listeners) fn(reason);
  }

  load(score: Score) {
    this.score = score;
    this.undoStack = [];
    this.redoStack = [];
    this.selectedId = null;
    this.range = null;
    this.rangeAnchor = null;
    this.cursor = { partIndex: 0, measureIndex: 0, eventIndex: 0 };
    this.emit('score');
  }

  /** カーソルのある小節の長さ（ティック） */
  get capacity() {
    return capacityAt(this.score, this.cursor.measureIndex);
  }

  /** その小節の長さ（拍子の変更・弱起を反映） */
  capacityOf(measure: number) {
    return capacityAt(this.score, measure);
  }

  /** その小節で有効な調号 */
  keyOf(measure: number) {
    return keyAt(this.score, measure);
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  /** 楽譜を変える操作はすべてこれで包む */
  private mutate(fn: () => void, coalesce?: string) {
    // ドラッグ中など、同じ操作の続きは1回の「元に戻す」にまとめる
    if (coalesce && coalesce === this.coalesceToken) {
      fn();
      this.score.updatedAt = Date.now();
      this.emit('score');
      return;
    }
    this.coalesceToken = coalesce ?? null;
    // 範囲を使う操作は fn の中で範囲を設定し直す。それ以外の操作では範囲を解く
    this.range = null;
    this.rangeAnchor = null;
    const before = JSON.stringify({ score: this.score, cursor: this.cursor, sel: this.selectedId });
    fn();
    this.score.updatedAt = Date.now();
    this.undoStack.push(before);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.emit('score');
  }

  private restore(snapshot: string) {
    const s = JSON.parse(snapshot);
    this.score = s.score;
    this.cursor = s.cursor;
    this.selectedId = s.sel;
    this.range = null;
    this.rangeAnchor = null;
  }

  private snapshot() {
    return JSON.stringify({ score: this.score, cursor: this.cursor, sel: this.selectedId });
  }

  /** ドラッグなどの一続きの操作の終わり */
  endGesture() {
    this.coalesceToken = null;
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
    this.emit('score');
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.restore(s);
    this.emit('score');
  }

  // ---------- 表示状態（楽譜は変えない） ----------

  setMode(mode: Mode) {
    this.mode = mode;
    if (mode !== 'select') { this.range = null; this.rangeAnchor = null; }
    this.emit('view');
  }

  setInputDuration(d: DurationType) {
    this.inputDuration = d;
    if (d === '32') this.inputDots = 0;
    // 選択中の音符があれば、その長さも変える（MuseScoreと同じ挙動）
    if (this.mode === 'select' && this.selectedId && !this.range) this.setSelectedDuration(d, this.inputDots);
    else this.emit('view');
  }

  toggleDot() {
    this.inputDots = this.inputDots ? 0 : 1;
    if (this.mode === 'select' && this.selectedId && !this.range) {
      const sel = this.selected;
      if (sel) this.setSelectedDuration(sel.duration, this.inputDots);
    } else this.emit('view');
  }

  toggleChordMode() {
    this.chordMode = !this.chordMode;
    this.emit('view');
  }

  /** 入力中の声部（0=声部1、1=声部2） */
  get voice(): number {
    return this.cursor.voice ?? 0;
  }

  /** 入力する声部を切り替える。カーソルは同じ拍の位置のまま、もう一方の声部へ移る */
  setVoice(voice: number) {
    if (voice === this.voice) return;
    const c = this.cursor;
    const m = this.score.parts[c.partIndex]?.measures[c.measureIndex];
    const tick = m ? tickOfIndex(voiceEvents(m, this.voice), c.eventIndex) : 0;
    this.setCursorAtTick(c.partIndex, c.measureIndex, voice, tick);
  }

  /**
   * カーソルを、小節の頭から tick の位置の声部 voice に置く。
   * 声部2が休符でまだないところや休符の途中なら、休符を分けて位置を作る（音は変わらないので元に戻すには残さない）。
   */
  setCursorAtTick(partIndex: number, measureIndex: number, voice: number, tick: number) {
    const m = this.score.parts[partIndex]?.measures[measureIndex];
    if (!m) return;
    const evs = ensureVoice(m, voice, this.capacityOf(measureIndex));
    const eventIndex = splitRestAt(evs, tick);
    const c: Cursor = { partIndex, measureIndex, eventIndex };
    if (voice) c.voice = voice;
    this.cursor = c;
    this.emit('score');
  }

  /** 選ばれている音符の id（範囲選択を足すときはここを広げる） */
  selectionIds(): string[] {
    return this.selectedId ? [this.selectedId] : [];
  }

  get selectedLocation(): EventLocation | null {
    return this.selectedId ? findEvent(this.score, this.selectedId) : null;
  }

  get selected(): MusicEvent | null {
    const loc = this.selectedLocation;
    return loc ? (eventAt(this.score, loc) ?? null) : null;
  }

  select(id: string | null, pitchIndex = 0) {
    this.range = null;
    this.rangeAnchor = null;
    this.selectedId = id;
    this.selectedPitchIndex = pitchIndex;
    const loc = id ? findEvent(this.score, id) : null;
    if (loc) {
      this.cursor = { ...loc };
      const ev = eventAt(this.score, loc);
      if (ev && this.mode === 'select') {
        this.inputDuration = ev.duration;
        this.inputDots = ev.dots;
      }
    }
    this.emit('view');
  }

  setCursor(c: Cursor) {
    this.cursor = { ...c };
    if (!this.cursor.voice) delete this.cursor.voice;
    this.emit('view');
  }

  /** 選択を前後の音符へ移す（delta = -1 / +1） */
  moveSelection(delta: number) {
    const loc = this.selectedLocation ?? this.cursor;
    const part = this.score.parts[loc.partIndex];
    const v = loc.voice ?? 0;
    let m = loc.measureIndex;
    let e = loc.eventIndex + delta;
    while (m >= 0 && m < part.measures.length) {
      const evs = voiceEvents(part.measures[m], v);
      if (e < 0) { m--; e = m >= 0 ? voiceEvents(part.measures[m], v).length - 1 : 0; continue; }
      if (e >= evs.length) { m++; e = 0; continue; }
      this.select(evs[e].id);
      return;
    }
  }

  // ---------- 入力 ----------

  /** 白鍵の位置（五線上の位置）で入力。調号の変化を付ける。手書き認識でも使う想定。 */
  inputDiatonic(index: number, alter?: number | null, chord = false) {
    const p = fromDiatonic(index);
    p.alter = alter ?? keyAlter(this.keyOf(this.cursor.measureIndex), p.step);
    this.inputPitches([p], chord);
  }

  /** 手書きの消しゴム：指定の音符・休符をまとめて休符に戻す（元に戻すは1回） */
  eraseEvents(ids: string[]) {
    const locs = ids.map((id) => findEvent(this.score, id)).filter((l): l is EventLocation => !!l);
    if (!locs.length) return;
    this.mutate(() => {
      const touched = new Map<Measure, number>();
      for (const id of ids) {
        const loc = findEvent(this.score, id);
        if (!loc) continue;
        const m = this.score.parts[loc.partIndex].measures[loc.measureIndex];
        const evs = voiceEvents(m, loc.voice);
        const ev = evs[loc.eventIndex];
        if (ev.kind === 'rest') continue;
        const rest = makeRest(ev.duration, ev.dots, ev.tuplet);
        copyTexts(ev, rest, false);
        evs[loc.eventIndex] = rest;
        const prev = loc.eventIndex > 0 ? evs[loc.eventIndex - 1] : undefined;
        if (prev?.kind === 'note') delete prev.tie;
        touched.set(m, loc.measureIndex);
      }
      for (const [m, mi] of touched) normalizeMeasure(m, this.capacityOf(mi));
      const first = locs[0];
      const m = this.score.parts[first.partIndex].measures[first.measureIndex];
      this.cursor = this.clampCursor({ ...first, eventIndex: first.eventIndex }, m);
      this.selectedId = null;
    });
  }

  /** MIDI番号で入力（画面の鍵盤から使う）。chord なら選択中の音符に重ねる。 */
  inputMidi(midi: number, chord = false) {
    this.inputPitches([fromMidi(midi, this.keyOf(this.cursor.measureIndex))], chord);
  }

  /** 音名キー（A〜G）で入力。直前の音にいちばん近いオクターブを選ぶ。 */
  inputStep(step: Step) {
    const prev = this.previousPitch();
    const base = prev ? diatonicIndex(prev) : diatonicIndex({ step: this.defaultStep(), octave: this.defaultOctave() });
    const target = STEPS.indexOf(step);
    let best = 0;
    let bestDist = Infinity;
    for (let idx = base - 7; idx <= base + 7; idx++) {
      if (((idx % 7) + 7) % 7 !== target) continue;
      const d = Math.abs(idx - base);
      if (d < bestDist) { best = idx; bestDist = d; }
    }
    this.inputDiatonic(best);
  }

  private defaultStep(): Step {
    return 'B';
  }

  private defaultOctave() {
    const part = this.score.parts[this.cursor.partIndex];
    const clef = part ? clefAt(part, this.cursor.measureIndex) : undefined;
    return clef === 'bass' ? 3 : clef === 'alto' ? 4 : 4;
  }

  private previousPitch(): Pitch | null {
    const part = this.score.parts[this.cursor.partIndex];
    for (let m = this.cursor.measureIndex; m >= 0; m--) {
      const evs = voiceEvents(part.measures[m], this.voice);
      const start = m === this.cursor.measureIndex ? Math.min(this.cursor.eventIndex, evs.length) - 1 : evs.length - 1;
      for (let e = start; e >= 0; e--) {
        const ev = evs[e];
        if (ev.kind === 'note') return ev.pitches[0];
      }
    }
    return null;
  }

  /** 入力の中心。和音モードなら選択中の音符に重ね、そうでなければカーソル位置に上書きで置いて進む。 */
  inputPitches(pitches: Pitch[], chord = false) {
    if ((chord || this.chordMode) && this.selected?.kind === 'note') {
      this.addToChord(pitches);
      return;
    }
    this.placeAtCursor(pitches);
  }

  inputRest() {
    this.placeAtCursor(null);
  }

  private ensureMeasure(index: number) {
    while (this.score.parts[0].measures.length <= index) {
      const cap = this.capacityOf(this.score.parts[0].measures.length);
      for (const p of this.score.parts) p.measures.push(createMeasure(cap));
    }
  }

  private placeAtCursor(pitches: Pitch[] | null) {
    this.mutate(() => this.placeAtCursorRaw(pitches));
  }

  private placeAtCursorRaw(pitches: Pitch[] | null) {
    {
      let { partIndex, measureIndex, eventIndex } = this.cursor;
      const voice = this.voice;
      const part = this.score.parts[partIndex];
      let total = ticksOf(this.inputDuration, this.inputDots);
      let firstId: string | null = null;
      let prevNote: NoteEvent | null = null;
      this.ensureMeasure(measureIndex);
      const inTuplet = voiceEvents(part.measures[measureIndex], voice)[eventIndex]?.tuplet;
      if (inTuplet) {
        // 連符の中：連符の残りに収まる長さで置く（連符の外へははみ出さない）
        const m = part.measures[measureIndex];
        const ev = overwriteInTuplet(m, eventIndex, { duration: this.inputDuration, dots: this.inputDots },
          (d) => (pitches ? makeNote(pitches, d.duration, d.dots) : makeRest(d.duration, d.dots)), voice);
        if (ev) {
          firstId = ev.id;
          eventIndex = voiceEvents(m, voice).indexOf(ev) + 1;
        }
        total = 0;
      }
      while (total > 0) {
        this.ensureMeasure(measureIndex);
        const cap = this.capacityOf(measureIndex);
        const m = part.measures[measureIndex];
        const evs = ensureVoice(m, voice, cap);
        const start = tickOfIndex(evs, eventIndex);
        if (start >= cap || eventIndex >= evs.length) {
          measureIndex++;
          eventIndex = 0;
          continue;
        }
        const room = cap - start;
        const take = Math.min(room, total);
        const pieces = take === ticksOf(this.inputDuration, this.inputDots)
          ? [{ duration: this.inputDuration, dots: this.inputDots }]
          : decompose(take);
        for (const pc of pieces) {
          const ev: MusicEvent = pitches ? makeNote(pitches, pc.duration, pc.dots) : makeRest(pc.duration, pc.dots);
          if (prevNote) prevNote.tie = true;
          overwriteAt(m, eventIndex, ev, beatTicks(timeSigAt(this.score, measureIndex)), voice);
          if (!firstId) firstId = ev.id;
          prevNote = ev.kind === 'note' ? ev : null;
          eventIndex++;
        }
        total -= take;
      }
      // 小節の終わりまで来たら次の小節の頭へ。最後の小節なら新しい小節を足す。
      const cur = part.measures[measureIndex];
      if (eventIndex >= voiceEvents(cur, voice).length) {
        measureIndex++;
        eventIndex = 0;
        this.ensureMeasure(measureIndex);
        ensureVoice(part.measures[measureIndex], voice, this.capacityOf(measureIndex));
      }
      this.cursor = voice ? { partIndex, measureIndex, eventIndex, voice } : { partIndex, measureIndex, eventIndex };
      this.selectedId = firstId;
      this.selectedPitchIndex = 0;
    }
  }

  private addToChord(pitches: Pitch[]) {
    const loc = this.selectedLocation;
    if (!loc) return;
    this.mutate(() => {
      const ev = eventAt(this.score, loc);
      if (!ev || ev.kind !== 'note') return;
      for (const p of pitches) if (!ev.pitches.some((q) => samePitch(p, q))) ev.pitches.push(p);
      ev.pitches.sort(comparePitch);
      this.selectedPitchIndex = ev.pitches.findIndex((q) => samePitch(q, pitches[0]));
    });
  }

  // ---------- 選択中の音符への操作 ----------

  /** 選択中の音を休符に置き換える。和音なら選択中の1音だけ消す。 */
  deleteSelected() {
    if (this.range) { this.deleteRange(); return; }
    const loc = this.selectedLocation;
    if (!loc) return;
    this.mutate(() => {
      const m = this.score.parts[loc.partIndex].measures[loc.measureIndex];
      const evs = voiceEvents(m, loc.voice);
      const ev = evs[loc.eventIndex];
      if (ev.kind === 'note' && ev.pitches.length > 1) {
        ev.pitches.splice(Math.min(this.selectedPitchIndex, ev.pitches.length - 1), 1);
        this.selectedPitchIndex = 0;
        return;
      }
      const rest = makeRest(ev.duration, ev.dots, ev.tuplet);
      copyTexts(ev, rest, false);
      evs[loc.eventIndex] = rest;
      this.selectedId = rest.id;
      if (loc.eventIndex > 0) {
        const prev = evs[loc.eventIndex - 1];
        if (prev.kind === 'note') delete prev.tie;
      }
      const before = evs.length;
      normalizeIfEmpty(m, this.capacityOf(loc.measureIndex));
      const after = voiceEvents(m, loc.voice);
      if (after !== evs || after.length !== before) this.selectedId = after[0]?.id ?? null;
      this.cursor = this.clampCursor({ ...loc }, m);
    });
  }

  setSelectedDuration(duration: DurationType, dots: number) {
    const loc = this.selectedLocation;
    if (!loc) return;
    this.mutate(() => {
      const cap = this.capacityOf(loc.measureIndex);
      const m = this.score.parts[loc.partIndex].measures[loc.measureIndex];
      const evs = voiceEvents(m, loc.voice);
      const ev = evs[loc.eventIndex];
      if (ev.tuplet) {
        // 連符の中：連符の中だけで長さを変える
        const tuplet = ev.tuplet;
        evs.splice(loc.eventIndex, 1, ...decompose(ticksOf(ev.duration, ev.dots)).map((d) => makeRest(d.duration, d.dots, tuplet)));
        const placed = overwriteInTuplet(m, loc.eventIndex, { duration, dots }, (d) => ({ ...ev, duration: d.duration, dots: d.dots }) as MusicEvent, loc.voice);
        if (placed) { this.inputDuration = placed.duration; this.inputDots = placed.dots; }
        return;
      }
      const start = tickOfIndex(evs, loc.eventIndex);
      let want = ticksOf(duration, dots);
      if (want > cap - start) {
        // 小節に収まらないときは、収まる最大の音価にする
        const fit = decompose(cap - start)[0];
        if (!fit) return;
        duration = fit.duration;
        dots = fit.dots;
        want = ticksOf(duration, dots);
      }
      const replaced: MusicEvent = { ...ev, duration, dots } as MusicEvent;
      // 元の音の長さ分を休符に戻してから、新しい長さで上書きし直す
      evs.splice(loc.eventIndex, 1, ...decomposeRests(eventTicks(ev)));
      overwriteAt(m, loc.eventIndex, replaced, beatTicks(timeSigAt(this.score, loc.measureIndex)), loc.voice);
      this.inputDuration = duration;
      this.inputDots = dots;
    });
  }

  /** 選択中の音を五線上で上下に動かす（steps = 白鍵の数）。調号の変化に合わせる。 */
  transposeSelected(steps: number, coalesce?: string) {
    if (this.range) { this.transposeRange(steps); return; }
    const loc = this.selectedLocation;
    const ev = this.selected;
    if (!loc || !ev || ev.kind !== 'note') return;
    this.mutate(() => {
      const note = eventAt(this.score, loc) as NoteEvent;
      const idxs = this.chordTargets(note);
      for (const i of idxs) {
        const p = note.pitches[i];
        const np = fromDiatonic(diatonicIndex(p) + steps);
        np.alter = keyAlter(this.keyOf(loc.measureIndex), np.step);
        note.pitches[i] = np;
      }
      const target = note.pitches[this.selectedPitchIndex];
      note.pitches.sort(comparePitch);
      this.selectedPitchIndex = Math.max(0, note.pitches.indexOf(target));
    }, coalesce);
  }

  /** 選択中の音を指定の五線位置へ（ドラッグで使う） */
  moveSelectedTo(diatonic: number) {
    const ev = this.selected;
    if (!ev || ev.kind !== 'note') return;
    const p = ev.pitches[this.selectedPitchIndex] ?? ev.pitches[0];
    const d = diatonic - diatonicIndex(p);
    if (d !== 0) this.transposeSelected(d, 'drag');
  }

  setSelectedAccidental(alter: number) {
    if (this.range) { this.setRangeAccidental(alter); return; }
    const loc = this.selectedLocation;
    const ev = this.selected;
    if (!loc || !ev || ev.kind !== 'note') return;
    this.mutate(() => {
      const note = eventAt(this.score, loc) as NoteEvent;
      for (const i of this.chordTargets(note)) {
        const p = note.pitches[i];
        // 同じボタンをもう一度押したら調号どおりに戻す
        note.pitches[i] = { ...p, alter: p.alter === alter ? keyAlter(this.keyOf(loc.measureIndex), p.step) : alter };
      }
    });
  }

  /**
   * タイ。入力モードで、直前に入れた音符の次にカーソルがあるときは、
   * MuseScoreと同じく同じ高さの音符を今の音価で足してタイでつなぐ。それ以外は付け外しを切り替える。
   */
  toggleTie() {
    const loc = this.selectedLocation;
    const ev = this.selected;
    if (!loc || !ev || ev.kind !== 'note') return;
    if (this.mode === 'input' && !ev.tie && this.cursorFollows(loc)) {
      this.mutate(() => {
        const note = eventAt(this.score, loc) as NoteEvent;
        const pitches = note.pitches.map((p) => ({ ...p }));
        this.placeAtCursorRaw(pitches);
        // 区切りを越えて分かれたときは、元の音符が別の位置に移っていないので id で取り直す
        const again = findEvent(this.score, note.id);
        const n = again ? (eventAt(this.score, again) as NoteEvent) : note;
        n.tie = true;
      });
      return;
    }
    this.mutate(() => {
      const note = eventAt(this.score, loc) as NoteEvent;
      if (note.tie) delete note.tie;
      else note.tie = true;
    });
  }

  /** 選択中の音符を、同じ小節内の隣と入れ替える */
  shiftSelected(delta: number) {
    const loc = this.selectedLocation;
    if (!loc) return;
    const evs = voiceEvents(this.score.parts[loc.partIndex].measures[loc.measureIndex], loc.voice);
    const j = loc.eventIndex + delta;
    if (j < 0 || j >= evs.length) return;
    // 連符の中と外は入れ替えない（連符の中どうしなら入れ替える）
    if ((evs[j].tuplet || evs[loc.eventIndex].tuplet) && evs[j].tuplet?.id !== evs[loc.eventIndex].tuplet?.id) return;
    this.mutate(() => {
      const [ev] = evs.splice(loc.eventIndex, 1);
      evs.splice(j, 0, ev);
      this.cursor = { ...loc, eventIndex: j };
    });
  }

  // ---------- 連符 ----------

  /** 連符を作る・外す対象：選択モードなら選んだ音、それ以外はカーソルの位置 */
  private tupletTarget(): EventLocation {
    const loc = this.mode === 'select' ? this.selectedLocation : null;
    return loc ?? { ...this.cursor };
  }

  /** 対象の音が連符の中にあるか */
  get inTuplet(): boolean {
    const loc = this.tupletTarget();
    const m = this.score.parts[loc.partIndex]?.measures[loc.measureIndex];
    return !!(m && voiceEvents(m, loc.voice)[loc.eventIndex]?.tuplet);
  }

  /**
   * actual 連符（3なら3連符）を作る。長さは、選択モードでは選んだ音の長さ、入力モードでは今の音価。
   * 選んだ音が音符なら、その高さを連符の1つ目にする。入力モードでは連符の頭から続けて入力できる。
   * 作れないときは理由を返す。
   */
  createTuplet(actual: number): string | null {
    const loc = this.tupletTarget();
    this.ensureMeasure(loc.measureIndex);
    const m = this.score.parts[loc.partIndex].measures[loc.measureIndex];
    const evs = ensureVoice(m, loc.voice ?? 0, this.capacityOf(loc.measureIndex));
    const target = evs[loc.eventIndex];
    if (!target) return '連符を置く位置がありません';
    if (target.tuplet) return 'すでに連符になっています（連符の中に連符は作れません）';
    const fromSelection = this.mode === 'select' && !!this.selectedId;
    const span = fromSelection ? eventTicks(target) : ticksOf(this.inputDuration, this.inputDots);
    const group = makeTupletGroup(span, actual, fromSelection ? target : undefined);
    if (!group) {
      return actual === 2 || actual === 4
        ? `${actual}連符は付点の音価（付点4分など）を選んでから作ってください`
        : 'この長さでは連符を作れません。もっと長い音価を選んでください';
    }
    const start = tickOfIndex(evs, loc.eventIndex);
    if (start + span > this.capacityOf(loc.measureIndex)) return '小節の残りに収まりません。短い音価を選ぶか、小節の頭で作ってください';
    this.mutate(() => {
      overwriteAt(m, loc.eventIndex, group, beatTicks(timeSigAt(this.score, loc.measureIndex)), loc.voice ?? 0);
      this.inputDuration = group[0].duration;
      this.inputDots = group[0].dots;
      this.cursor = { ...loc };
      this.selectedId = group[0].id;
      this.selectedPitchIndex = 0;
    });
    return null;
  }

  /** 対象の音を含む連符を外し、その長さの休符に戻す */
  removeTuplet() {
    const loc = this.tupletTarget();
    const m = this.score.parts[loc.partIndex]?.measures[loc.measureIndex];
    const evs = m ? voiceEvents(m, loc.voice) : [];
    const range = m ? tupletRange(evs, loc.eventIndex) : null;
    if (!m || !range) return;
    this.mutate(() => {
      const [s, e] = range;
      const len = evs.slice(s, e).reduce((x, ev) => x + eventTicks(ev), 0);
      const rests = restsFor(len);
      evs.splice(s, e - s, ...rests);
      const prev = evs[s - 1];
      if (prev?.kind === 'note') delete prev.tie;
      normalizeMeasure(m, this.capacityOf(loc.measureIndex));
      this.cursor = this.clampCursor({ ...loc, eventIndex: s }, m);
      this.selectedId = voiceEvents(m, loc.voice)[this.cursor.eventIndex]?.id ?? null;
    });
  }

  /** カーソルが、loc の音符のすぐ次を指しているか */
  private cursorFollows(loc: EventLocation): boolean {
    const c = this.cursor;
    if (c.partIndex !== loc.partIndex || (c.voice ?? 0) !== (loc.voice ?? 0)) return false;
    const m = this.score.parts[loc.partIndex].measures[loc.measureIndex];
    if (c.measureIndex === loc.measureIndex) return c.eventIndex === loc.eventIndex + 1;
    return loc.eventIndex === voiceEvents(m, loc.voice).length - 1 && c.measureIndex === loc.measureIndex + 1 && c.eventIndex === 0;
  }

  /** 声部2が消えたときなどに、カーソルを小節の中に収める */
  private clampCursor(c: Cursor, m: Measure): Cursor {
    if (c.voice && !m.voice2) return { ...c, eventIndex: 0 };
    const n = voiceEvents(m, c.voice).length;
    return { ...c, eventIndex: Math.max(0, Math.min(c.eventIndex, n - 1)) };
  }

  private chordTargets(note: NoteEvent): number[] {
    if (note.pitches.length === 1) return [0];
    return [Math.min(this.selectedPitchIndex, note.pitches.length - 1)];
  }

  // ---------- 歌詞・コードネーム・文字（src/model/texts.ts） ----------

  /** 歌詞を設定する（空なら消す）。入力中の1音節は coalesce で1回の「元に戻す」にまとめる */
  setLyric(id: string, verse: number, text: string, coalesce?: string) {
    const loc = findEvent(this.score, id);
    const ev = loc && eventAt(this.score, loc);
    if (!ev || ev.kind !== 'note' || lyricOf(ev, verse) === text) return;
    this.mutate(() => setLyricOn(ev, verse, text), coalesce);
  }

  /** コードネーム（field='chord'）か譜表の上の文字（field='text'）を設定する。空なら消す */
  setEventText(id: string, field: 'chord' | 'text', text: string, coalesce?: string) {
    const loc = findEvent(this.score, id);
    const ev = loc && eventAt(this.score, loc);
    if (!ev || (ev[field] ?? '') === text) return;
    this.mutate(() => {
      if (text) ev[field] = text;
      else delete ev[field];
    }, coalesce);
  }

  /** 練習番号（小節の頭、いちばん上のパートに付ける）。空なら消す */
  setRehearsal(measureIndex: number, text: string, coalesce?: string) {
    const m = this.score.parts[0].measures[measureIndex];
    if (!m || (m.rehearsal ?? '') === text) return;
    this.mutate(() => {
      if (text) m.rehearsal = text;
      else delete m.rehearsal;
    }, coalesce);
  }

  // ---------- 記号（スラー・強弱・アーティキュレーション） ----------

  /** 選んだ音符のアーティキュレーションを付け外し（和音は音符全体に付く） */
  toggleArticulation(a: Articulation) {
    const loc = this.selectedLocation;
    if (!loc) return;
    this.mutate(() => toggleArticulationOn(eventAt(this.score, loc)!, a));
  }

  /** 選んだ音符の強弱記号。同じものをもう一度選ぶか null で消す */
  setDynamic(d: Dynamic | null) {
    const loc = this.selectedLocation;
    if (!loc) return;
    this.mutate(() => setDynamicOn(eventAt(this.score, loc)!, d));
  }

  /**
   * スラー・クレッシェンド・ディミヌエンドの付け外し。
   * 選択モード：選んだ音符から次の音符へ（続けて押すと伸びる、始まりの音符で押すと消える）。
   * 入力モード（直前に入れた音符を選んでいる）：その前の音符からこの音符へ（続けて入れて押すと伸びる）。
   */
  toggleSpanner(kind: SpannerKind) {
    const loc = this.selectedLocation;
    const id = this.selectedId;
    if (!loc || !id) return;
    const append = this.mode !== 'select' && this.cursorFollows(loc);
    this.mutate(() => {
      const next = toggleSpannerAt(this.score, kind, id, append);
      if (!append && next && next !== id) {
        const nl = findEvent(this.score, next);
        if (nl) {
          this.selectedId = next;
          this.selectedPitchIndex = 0;
          this.cursor = { ...nl };
        }
      }
    });
  }

  // ---------- 装飾音 ----------

  /**
   * 選んだ音符の前に装飾音を1つ足す（入力モードでは直前に入れた音符。MuseScore と同じ）。
   * 高さは本音符のいちばん上の音の1つ上（調号どおり）。足したあと shiftGrace() で上下に動かせる。
   */
  addGrace(slash: boolean, duration: GraceNote['duration'] = '8') {
    const loc = this.selectedLocation;
    if (!loc || this.selected?.kind !== 'note') return;
    this.mutate(() => {
      const note = eventAt(this.score, loc) as NoteEvent;
      const top = note.pitches[note.pitches.length - 1];
      const p = fromDiatonic(diatonicIndex(top) + 1);
      p.alter = keyAlter(this.keyOf(loc.measureIndex), p.step);
      (note.graces ??= []).push({ pitches: [p], duration, ...(slash ? { slash: true } : {}) });
    });
  }

  /** 選んだ音符のいちばん後ろ（本音符のすぐ前）の装飾音を steps 白鍵ぶん上下に動かす */
  shiftGrace(steps: number) {
    const loc = this.selectedLocation;
    const ev = this.selected;
    if (!loc || ev?.kind !== 'note' || !ev.graces?.length) return;
    this.mutate(() => {
      const note = eventAt(this.score, loc) as NoteEvent;
      const g = note.graces![note.graces!.length - 1];
      g.pitches = g.pitches.map((p) => {
        const np = fromDiatonic(diatonicIndex(p) + steps);
        np.alter = keyAlter(this.keyOf(loc.measureIndex), np.step);
        return np;
      }).sort(comparePitch);
    }, 'grace-shift');
  }

  /** いちばん後ろの装飾音の臨時記号（同じものをもう一度で調号どおり） */
  setGraceAccidental(alter: number) {
    const loc = this.selectedLocation;
    const ev = this.selected;
    if (!loc || ev?.kind !== 'note' || !ev.graces?.length) return;
    this.mutate(() => {
      const note = eventAt(this.score, loc) as NoteEvent;
      const g = note.graces![note.graces!.length - 1];
      g.pitches = g.pitches.map((p) => ({ ...p, alter: p.alter === alter ? keyAlter(this.keyOf(loc.measureIndex), p.step) : alter }));
    });
  }

  /** 装飾音をすべて消す（last=true ならいちばん後ろの1つだけ） */
  removeGraces(last = false) {
    const loc = this.selectedLocation;
    const ev = this.selected;
    if (!loc || ev?.kind !== 'note' || !ev.graces?.length) return;
    this.mutate(() => {
      const note = eventAt(this.score, loc) as NoteEvent;
      if (last) note.graces!.pop();
      if (!last || !note.graces!.length) delete note.graces;
    });
  }

  // ---------- 範囲選択・コピー・貼り付け ----------

  /** 範囲に入っている音符・休符の id（描画用） */
  get rangeIds(): Set<string> | null {
    return this.range ? rangeEventIds(this.score, this.range) : null;
  }

  /** 範囲をそのまま設定する（起点も同じ範囲） */
  setRange(r: RangeSel | null) {
    this.range = r ? { ...r } : null;
    this.rangeAnchor = r ? { ...r } : null;
    this.afterRangeChange();
    this.emit('view');
  }

  /** 選択中の音（または範囲の起点）から id の音までを範囲にする。Shift+タップ・なぞり選択で使う */
  extendSelectionTo(id: string) {
    const target = eventSpan(this.score, id);
    if (!target) return;
    if (!this.rangeAnchor) {
      const from = this.selectedId ? eventSpan(this.score, this.selectedId) : null;
      if (!from) { this.select(id); return; }
      this.rangeAnchor = { partFrom: from.partIndex, partTo: from.partIndex, start: from.start, end: from.end };
    }
    const a = this.rangeAnchor;
    this.range = {
      partFrom: Math.min(a.partFrom, target.partIndex),
      partTo: Math.max(a.partTo, target.partIndex),
      start: Math.min(a.start, target.start),
      end: Math.max(a.end, target.end),
    };
    this.afterRangeChange(id);
    this.emit('view');
  }

  /** 1つの音から別の音までを範囲にする（長押しでなぞる選択の始まり） */
  selectRange(anchorId: string, focusId: string) {
    const a = eventSpan(this.score, anchorId);
    if (!a) return;
    this.rangeAnchor = { partFrom: a.partIndex, partTo: a.partIndex, start: a.start, end: a.end };
    this.range = null;
    this.extendSelectionTo(focusId);
  }

  /** 小節単位で選ぶ（mTo まで含む） */
  selectMeasures(partFrom: number, partTo: number, mFrom: number, mTo: number) {
    const n = this.score.parts[0].measures.length;
    const a = Math.max(0, Math.min(mFrom, mTo));
    const b = Math.min(n - 1, Math.max(mFrom, mTo));
    this.setRange({
      partFrom: Math.min(partFrom, partTo), partTo: Math.max(partFrom, partTo),
      start: measureStartTick(this.score, a), end: measureStartTick(this.score, b + 1),
    });
  }

  selectAll() {
    this.selectMeasures(0, this.score.parts.length - 1, 0, this.score.parts[0].measures.length - 1);
  }

  /** 範囲の最後の音へ、前後に1つずつ広げる・縮める（Shift+←→） */
  extendByStep(delta: number) {
    const focus = this.selectedId;
    if (!focus) return;
    const loc = findEvent(this.score, focus);
    if (!loc) return;
    const part = this.score.parts[loc.partIndex];
    // 選んでいる音の声部の中で前後へ。となりの小節にその声部がなければ声部1の音
    const list = (mi: number) => {
      const m = part.measures[mi];
      if (!m) return [];
      const evs = voiceEvents(m, loc.voice);
      return evs.length ? evs : m.events;
    };
    let m = loc.measureIndex;
    let e = loc.eventIndex + delta;
    if (e < 0) { m--; e = m >= 0 ? list(m).length - 1 : 0; }
    else if (e >= list(m).length) { m++; e = 0; }
    const ev = list(m)[e];
    if (!ev) return;
    if (!this.rangeAnchor) this.extendSelectionTo(focus);
    // 起点より手前に戻ってきたら、起点から広げ直す
    const a = this.rangeAnchor!;
    const t = eventSpan(this.score, ev.id)!;
    this.range = {
      partFrom: Math.min(a.partFrom, t.partIndex), partTo: Math.max(a.partTo, t.partIndex),
      start: Math.min(a.start, t.start), end: Math.max(a.end, t.end),
    };
    this.afterRangeChange(ev.id);
    this.emit('view');
  }

  clearRange() {
    if (!this.range) return;
    this.range = null;
    this.rangeAnchor = null;
    this.emit('view');
  }

  private afterRangeChange(focusId?: string) {
    if (!this.range) return;
    const ends = rangeEnds(this.score, this.range);
    this.selectedId = focusId ?? ends?.last ?? null;
    this.selectedPitchIndex = 0;
    const first = ends ? findEvent(this.score, ends.first) : null;
    if (first) this.cursor = { ...first };
  }

  /** いまコピーの対象になるもの：範囲（両方の声部）、なければ選択中の1音（その音の声部だけ） */
  private copySource(): RangeSel | null {
    if (this.range) return this.range;
    if (!this.selectedId) return null;
    const s = eventSpan(this.score, this.selectedId);
    return s ? { partFrom: s.partIndex, partTo: s.partIndex, start: s.start, end: s.end, voice: s.voice } : null;
  }

  get canCopy() {
    return !!this.copySource();
  }

  get canPaste() {
    return !!this.clipboard && !!this.pasteTarget();
  }

  copy(): boolean {
    const r = this.copySource();
    if (!r) return false;
    this.clipboard = extractRange(this.score, r);
    this.emit('view');
    return true;
  }

  cut(): boolean {
    const r = this.copySource();
    if (!r) return false;
    this.clipboard = extractRange(this.score, r);
    this.mutate(() => this.clearRaw(r));
    return true;
  }

  /** 範囲（なければ選択中の1音）を休符にする */
  deleteRange() {
    const r = this.copySource();
    if (!r) return;
    this.mutate(() => this.clearRaw(r));
  }

  private clearRaw(r: RangeSel) {
    clearRange(this.score, r);
    this.range = { ...r };
    this.rangeAnchor = { ...r };
    this.afterRangeChange();
  }

  /**
   * 貼り付ける位置：範囲の頭 → 選択中の音 → 入力位置（カーソル）。
   * voice は1つの声部だけのコピーを貼る声部（選択中の音・入力位置の声部）
   */
  private pasteTarget(): { partIndex: number; start: number; voice: number } | null {
    if (this.range) return { partIndex: this.range.partFrom, start: this.range.start, voice: this.range.voice ?? 0 };
    if (this.selectedId && this.mode !== 'input') {
      const s = eventSpan(this.score, this.selectedId);
      if (s) return { partIndex: s.partIndex, start: s.start, voice: s.voice };
    }
    const c = this.cursor;
    const part = this.score.parts[c.partIndex];
    const m = part?.measures[c.measureIndex];
    if (!m) return null;
    const voice = c.voice ?? 0;
    const events = voiceEvents(m, voice);
    let t = measureStartTick(this.score, c.measureIndex);
    if (voice && !events.length) {
      // 声部2のない小節：入力位置は声部1の音の番号で数える
      for (let i = 0; i < Math.min(c.eventIndex, m.events.length); i++) t += eventTicks(m.events[i]);
    } else {
      for (let i = 0; i < Math.min(c.eventIndex, events.length); i++) t += eventTicks(events[i]);
    }
    return { partIndex: c.partIndex, start: t, voice };
  }

  /** 貼り付け。貼った所を範囲として選び、入力位置はその次へ */
  paste(): boolean {
    const clip = this.clipboard;
    const at = this.pasteTarget();
    if (!clip || !at) return false;
    this.mutate(() => {
      const r = pasteClip(this.score, clip, at.partIndex, at.start, at.voice);
      if (!r) return;
      if (this.mode === 'select') {
        this.range = { ...r };
        this.rangeAnchor = { ...r };
        this.afterRangeChange();
      } else {
        this.selectedId = null;
      }
      // 入力位置は貼った所のすぐ後ろ（入力モードで最後まで来たら、入力と同じく小節を足す）。
      // 1つの声部だけを貼ったときはその声部、それ以外は今の入力の声部のまま
      const voice = r.voice ?? (this.cursor.voice ?? 0);
      const withVoice = (c: Cursor): Cursor => (voice ? { ...c, voice } : c);
      let mi = 0;
      while (measureStartTick(this.score, mi + 1) <= r.end) mi++;
      if (this.mode === 'input') this.ensureMeasure(mi);
      const ms = this.score.parts[r.partFrom].measures;
      if (mi >= ms.length) {
        mi = ms.length - 1;
        const last = voiceEvents(ms[mi], voice);
        this.cursor = withVoice({ partIndex: r.partFrom, measureIndex: mi, eventIndex: Math.max(0, (last.length || ms[mi].events.length) - 1) });
        return;
      }
      if (voice) {
        // 声部2の途中なら、その位置に休符の区切りを作って置く
        this.cursor = withVoice({ partIndex: r.partFrom, measureIndex: mi, eventIndex: 0 });
        const tick = r.end - measureStartTick(this.score, mi);
        this.cursor.eventIndex = splitRestAt(ensureVoice(ms[mi], voice, this.capacityOf(mi)), tick);
        return;
      }
      const m = ms[mi];
      let t = measureStartTick(this.score, mi);
      let ei = 0;
      while (ei < m.events.length && t < r.end) { t += eventTicks(m.events[ei]); ei++; }
      this.cursor = { partIndex: r.partFrom, measureIndex: mi, eventIndex: ei };
    });
    return true;
  }

  private transposeRange(steps: number) {
    const r = this.range!;
    this.mutate(() => {
      for (const note of rangeNotes(this.score, r)) {
        const key = this.keyOf(findEvent(this.score, note.id)?.measureIndex ?? 0);
        const move = (ps: Pitch[]) => ps.map((p) => {
          const np = fromDiatonic(diatonicIndex(p) + steps);
          np.alter = keyAlter(key, np.step);
          return np;
        }).sort(comparePitch);
        note.pitches = move(note.pitches);
        for (const g of note.graces ?? []) g.pitches = move(g.pitches);
      }
      this.range = { ...r };
      this.rangeAnchor = { ...r };
      this.afterRangeChange(this.selectedId ?? undefined);
    });
  }

  private setRangeAccidental(alter: number) {
    const r = this.range!;
    const focus = this.selectedId;
    this.mutate(() => {
      const notes = rangeNotes(this.score, r);
      // 全部がすでにその記号なら調号どおりに戻す
      const all = notes.every((n) => n.pitches.every((p) => p.alter === alter));
      for (const n of notes) {
        const key = this.keyOf(findEvent(this.score, n.id)?.measureIndex ?? 0);
        n.pitches = n.pitches.map((p) => ({ ...p, alter: all ? keyAlter(key, p.step) : alter }));
      }
      this.range = { ...r };
      this.rangeAnchor = { ...r };
      this.afterRangeChange(focus ?? undefined);
    });
  }

  // ---------- 小節・楽譜全体 ----------

  addMeasure(after = this.score.parts[0].measures.length - 1) {
    this.mutate(() => {
      const at = after + 1;
      if (at === 0 && this.score.pickup) {
        // 弱起の前に挿入：もとの弱起の小節は普通の長さにして、新しい小節を弱起にする
        const full = measureCapacity(timeSigAt(this.score, 0));
        for (const p of this.score.parts) {
          const m0 = p.measures[0];
          const pad = full - measureTicks(m0);
          m0.events = [...restsFor(pad), ...m0.events];
          if (m0.voice2) m0.voice2 = [...restsFor(pad), ...m0.voice2];
          normalizeMeasure(m0, full);
        }
      }
      for (const p of this.score.parts) p.measures.splice(at, 0, { id: '', events: [] });
      shiftMeasureMarks(this.score, at, 1);
      const cap = this.capacityOf(at);
      for (const p of this.score.parts) p.measures[at] = createMeasure(cap);
    });
  }

  /** テンポを設定する。measure 0 は曲の最初のテンポ、それ以外は途中のテンポ変更 */
  setTempo(measure: number, tempo: number) {
    tempo = Math.round(Math.min(300, Math.max(20, tempo)));
    this.mutate(() => {
      if (measure <= 0) { this.score.tempo = tempo; return; }
      const marks = (this.score.tempoMarks ??= []);
      const m = marks.find((t) => t.measure === measure);
      if (m) m.tempo = tempo;
      else marks.push({ measure, tempo });
      marks.sort((a, b) => a.measure - b.measure);
    });
  }

  /** 途中のテンポ変更を消す */
  removeTempo(measure: number) {
    if (!this.score.tempoMarks?.some((t) => t.measure === measure)) return;
    this.mutate(() => {
      this.score.tempoMarks = this.score.tempoMarks!.filter((t) => t.measure !== measure);
    });
  }

  removeMeasure(index = this.cursor.measureIndex) {
    if (this.score.parts[0].measures.length <= 1) return;
    this.mutate(() => {
      // 消す小節で音部記号が変わっていたら、次の小節へ引き継ぐ（次の小節に指定がなければ）
      for (const p of this.score.parts) {
        const c = p.measures[index]?.clef;
        const next = p.measures[index + 1];
        if (c && next && !next.clef) next.clef = c;
        if (index === 0 && next?.clef) { p.clef = next.clef; delete next.clef; }
      }
      for (const p of this.score.parts) p.measures.splice(index, 1);
      // 消した小節のテンポ・拍子・調号の変更は次の小節へ引き継ぐ（後ろにすでにあればそちらを優先）
      shiftMeasureMarks(this.score, index, -1);
      if (index === 0) delete this.score.pickup;
      const n = this.score.parts[0].measures.length;
      this.cursor = { partIndex: this.cursor.partIndex, measureIndex: Math.min(index, n - 1), eventIndex: 0 };
      this.selectedId = null;
    });
  }

  updateMeta(meta: Partial<Pick<Score, 'title' | 'composer' | 'tempo' | 'tuning'>>) {
    this.mutate(() => Object.assign(this.score, meta));
  }

  setKeySignature(fifths: number) {
    // MuseScore と同じく、今ある音の高さはそのまま残す（調号と違う音には臨時記号が付く）
    this.mutate(() => {
      this.score.keyFifths = fifths;
    });
  }

  /** 曲頭の拍子を変える（途中の拍子変更がある所まで小節を引き直す） */
  setTimeSignature(ts: TimeSignature) {
    this.setTimeSignatureAt(0, ts);
  }

  /**
   * measure 小節目から拍子を変える。null なら途中の拍子変更を消して、前の拍子に戻す。
   * その小節から次の拍子変更の手前までの音を、新しい小節の長さに並べ直す（小節をまたぐ音はタイで分ける）。
   */
  setTimeSignatureAt(measure: number, ts: TimeSignature | null) {
    if (measure === 0 && !ts) return;
    this.mutate(() => {
      const score = this.score;
      if (measure === 0) score.timeSignature = { ...ts! };
      else {
        const prev = timeSigAt(score, measure - 1);
        const same = !ts || (ts.beats === prev.beats && ts.beatType === prev.beatType);
        updateMeasureAttrs(score, measure, (a) => { a.timeSignature = same ? undefined : { ...ts! }; });
      }
      const n = score.parts[0].measures.length;
      let segEnd = n;
      for (const a of score.measureAttrs ?? []) if (a.measure > measure && a.timeSignature) { segEnd = Math.min(segEnd, a.measure); }
      this.rebar(measure, segEnd);
      this.cursor = { partIndex: this.cursor.partIndex, measureIndex: Math.min(measure, score.parts[0].measures.length - 1), eventIndex: 0 };
      this.selectedId = null;
    });
  }

  /**
   * [segStart, segEnd) の小節を、今の拍子（と弱起）の長さで引き直す。
   * 中にあるテンポ変更・小節の記号は同じ時間位置の小節へ、後ろのものは小節数の増減だけずらす。
   */
  private rebar(segStart: number, segEnd: number) {
    const score = this.score;
    const oldCount = segEnd - segStart;
    const ts = timeSigAt(score, segStart);
    const full = measureCapacity(ts);
    const capOf = (j: number) => (segStart + j === 0 ? capacityAt(score, 0) : full);
    // もとの小節の開始位置（区間の頭から何ティック目か）
    const oldStarts: number[] = [];
    let t = 0;
    for (let i = segStart; i < segEnd; i++) {
      oldStarts.push(t);
      t += Math.max(...score.parts.map((p) => measureTicks(p.measures[i])));
    }
    const segs = score.parts.map((p) => reflowMeasures(p.measures.slice(segStart, segEnd), capOf, beatTicks(ts)));
    const newCount = Math.max(...segs.map((x) => x.length));
    segs.forEach((x) => { while (x.length < newCount) x.push(createMeasure(capOf(x.length))); });
    score.parts.forEach((p, i) => p.measures.splice(segStart, oldCount, ...segs[i]));
    const newIndexOf = (tick: number) => {
      let acc = 0;
      for (let j = 0; j < newCount; j++) {
        acc += capOf(j);
        if (tick < acc) return segStart + j;
      }
      return segStart + newCount - 1;
    };
    const remap = (m: number) => {
      if (m <= segStart) return m;
      if (m >= segEnd) return m + newCount - oldCount;
      return newIndexOf(oldStarts[m - segStart]);
    };
    if (score.tempoMarks) {
      const seen = new Set<number>();
      score.tempoMarks = score.tempoMarks
        .map((x) => ({ ...x, measure: remap(x.measure) }))
        .filter((x) => x.measure >= 1 && !seen.has(x.measure) && !!seen.add(x.measure));
    }
    if (score.measureAttrs) {
      const out: typeof score.measureAttrs = [];
      for (const a of score.measureAttrs) {
        const m = remap(a.measure);
        const prev = out.find((u) => u.measure === m);
        if (prev) Object.assign(prev, { ...a, measure: m });
        else out.push({ ...a, measure: m });
      }
      score.measureAttrs = out.sort((a, b) => a.measure - b.measure);
    }
  }

  /** measure 小節目から調号を変える。null なら途中の調号変更を消す。音の高さは変えない（必要なら臨時記号が付く） */
  setKeyAt(measure: number, fifths: number | null) {
    if (measure === 0) { if (fifths !== null) this.setKeySignature(fifths); return; }
    this.mutate(() => {
      const prev = keyAt(this.score, measure - 1);
      updateMeasureAttrs(this.score, measure, (a) => { a.keyFifths = fifths === null || fifths === prev ? undefined : fifths; });
    });
  }

  /** measure 小節目のあとで改行・改ページする／しない。改ページは改行も兼ねる */
  setBreak(measure: number, patch: { system?: boolean; page?: boolean }) {
    this.mutate(() => {
      updateMeasureAttrs(this.score, measure, (a) => {
        if ('system' in patch) a.systemBreak = patch.system || undefined;
        if ('page' in patch) a.pageBreak = patch.page || undefined;
        if (a.pageBreak) a.systemBreak = undefined;
      });
    });
  }

  /** measure 小節目のあとの改行を切り替える（改ページがあれば外す） */
  toggleSystemBreak(measure: number) {
    const a = measureAttrsAt(this.score, measure);
    const on = !!(a?.systemBreak || a?.pageBreak);
    this.setBreak(measure, { system: !on, page: false });
  }

  /** 1段の小節数。null（または0）で横幅に合わせて自動 */
  setMeasuresPerSystem(n: number | null) {
    const want = n && n > 0 ? Math.min(16, Math.floor(n)) : undefined;
    if (want === this.score.layout?.measuresPerSystem) return;
    this.mutate(() => {
      if (want) this.score.layout = { ...this.score.layout, measuresPerSystem: want };
      else if (this.score.layout) {
        delete this.score.layout.measuresPerSystem;
        if (!Object.keys(this.score.layout).length) delete this.score.layout;
      }
    });
  }

  /** リピート記号・番号付きカッコを付け外しする */
  setRepeat(measure: number, patch: { repeatStart?: boolean; repeatEnd?: boolean; volta?: number[] | null; repeatTimes?: number | null }) {
    this.mutate(() => {
      updateMeasureAttrs(this.score, measure, (a) => {
        if ('repeatStart' in patch) a.repeatStart = patch.repeatStart || undefined;
        if ('repeatEnd' in patch) a.repeatEnd = patch.repeatEnd || undefined;
        if ('volta' in patch) a.volta = patch.volta?.length ? [...patch.volta].sort((x, y) => x - y) : undefined;
        if ('repeatTimes' in patch) a.repeatTimes = patch.repeatTimes && patch.repeatTimes > 2 ? patch.repeatTimes : undefined;
        if (!a.repeatEnd) a.repeatTimes = undefined;
      });
    });
  }

  /**
   * 弱起（1小節目を短くする）。ticks = 0 で普通の小節に戻す。
   * 縮めるとき、1小節目の前の方が休符だけなら後ろを残し（休符のあとに弱起の音を書いた場合）、
   * そうでなければ前を残す。伸ばすときは前に休符を足す。
   */
  setPickup(ticks: number) {
    const full = measureCapacity(timeSigAt(this.score, 0));
    const want = ticks > 0 && ticks < full ? ticks : 0;
    if ((this.score.pickup ?? 0) === want) return;
    this.mutate(() => {
      const newCap = want || full;
      for (const p of this.score.parts) {
        const m0 = p.measures[0];
        const cur = measureTicks(m0);
        if (newCap >= cur) {
          m0.events = [...restsFor(newCap - cur), ...m0.events];
          if (m0.voice2) m0.voice2 = [...restsFor(newCap - cur), ...m0.voice2];
        } else {
          const drop = cur - newCap;
          const [head, tail] = reflowMeasures([m0], (j) => (j === 0 ? drop : newCap));
          const headIsRest = measureEvents(head).every((e) => e.kind === 'rest');
          const keep = headIsRest ? tail : reflowMeasures([m0], (j) => (j === 0 ? newCap : drop))[0];
          m0.events = keep?.events ?? restsFor(newCap);
          if (keep?.voice2) m0.voice2 = keep.voice2;
          else delete m0.voice2;
          if (!headIsRest) {
            for (const evs of [m0.events, m0.voice2 ?? []]) {
              const last = evs[evs.length - 1];
              if (last?.kind === 'note') delete last.tie;
            }
          }
        }
        normalizeMeasure(m0, newCap);
      }
      if (want) this.score.pickup = want;
      else delete this.score.pickup;
      this.cursor = { partIndex: this.cursor.partIndex, measureIndex: 0, eventIndex: 0 };
      this.selectedId = null;
    });
  }

  /**
   * 移調。音程（白鍵の数と半音の数）で動かす。楽譜全体なら調号も一緒に変え、
   * 調号が7つを超えるときは異名同音の調（例：嬰ト長調→変イ長調）に読み替える。
   * 譜表・音符だけのときは調号はそのままで、臨時記号で書く。
   */
  transpose(interval: Interval, scope: TransposeScope = { kind: 'all' }) {
    if (!interval.steps && !interval.semitones) return;
    const ids = scope.kind === 'ids' ? new Set(scope.ids) : null;
    if (ids && !ids.size) return;
    this.mutate(() => {
      let iv = interval;
      if (scope.kind === 'all') {
        const k = transposeKey(this.score.keyFifths, interval);
        this.score.keyFifths = k.fifths;
        iv = k.interval;
        // 曲の途中の調号の変更も同じだけ動かす
        for (const a of this.score.measureAttrs ?? []) if (a.keyFifths !== undefined) a.keyFifths = transposeKey(a.keyFifths, interval).fifths;
      }
      this.score.parts.forEach((part, pi) => {
        if (scope.kind === 'part' && scope.partIndex !== pi) return;
        for (const m of part.measures)
          for (const ev of measureEvents(m)) {
            if (ev.kind !== 'note' || (ids && !ids.has(ev.id))) continue;
            ev.pitches = ev.pitches.map((p) => transposePitch(p, iv)).sort(comparePitch);
            for (const g of ev.graces ?? []) g.pitches = g.pitches.map((p) => transposePitch(p, iv)).sort(comparePitch);
          }
      });
    });
  }

  /** 小節の記号（表示用） */
  measureAttrs(measure: number) {
    return measureAttrsAt(this.score, measure);
  }

  addPart(clef: Clef) {
    this.mutate(() => {
      const n = this.score.parts[0].measures.length;
      this.score.parts.push(createPart(clef === 'bass' ? '左手' : '譜表' + (this.score.parts.length + 1), clef, n, (i) => this.capacityOf(i)));
    });
  }

  removePart(index: number) {
    if (this.score.parts.length <= 1) return;
    this.mutate(() => {
      this.score.parts.splice(index, 1);
      this.cursor = { partIndex: 0, measureIndex: this.cursor.measureIndex, eventIndex: 0 };
      this.selectedId = null;
    });
  }

  setPartInstrument(index: number, instrument: Instrument) {
    this.mutate(() => {
      this.score.parts[index].instrument = instrument;
    });
  }

  setPartClef(index: number, clef: Clef) {
    this.mutate(() => {
      const part = this.score.parts[index];
      part.clef = clef;
      delete part.measures[0]?.clef;
      dropRedundantClefs(part);
    });
  }

  /**
   * パートの measure 小節目から音部記号を変える（音の高さは変えない。書く位置が変わる）。
   * null なら途中の変更を消して前の音部記号に戻す。1小節目ならパートの音部記号を変える。
   */
  setClefAt(partIndex: number, measure: number, clef: Clef | null) {
    const part = this.score.parts[partIndex];
    if (!part) return;
    if (measure === 0) { if (clef) this.setPartClef(partIndex, clef); return; }
    this.mutate(() => {
      const m = part.measures[measure];
      if (!m) return;
      if (clef) m.clef = clef;
      else delete m.clef;
      dropRedundantClefs(part);
    });
  }

  /** その小節で有効な音部記号 */
  clefAt(partIndex: number, measure: number): Clef {
    return clefAt(this.score.parts[partIndex], measure);
  }

  /** セーニョ・コーダ・To Coda・Fine・D.C./D.S. を付け外しする（全パート共通） */
  setFlow(measure: number, patch: { segno?: boolean; coda?: boolean; toCoda?: boolean; fine?: boolean; jump?: JumpKind | null }) {
    this.mutate(() => {
      updateMeasureAttrs(this.score, measure, (a) => {
        if ('segno' in patch) a.segno = patch.segno || undefined;
        if ('coda' in patch) a.coda = patch.coda || undefined;
        if ('toCoda' in patch) a.toCoda = patch.toCoda || undefined;
        if ('fine' in patch) a.fine = patch.fine || undefined;
        if ('jump' in patch) a.jump = patch.jump || undefined;
      });
    });
  }
}

/** 前の小節と同じ音部記号の指定（意味のない変更）を消す */
function dropRedundantClefs(part: { clef: Clef; measures: Measure[] }) {
  let cur = part.clef;
  part.measures.forEach((m, i) => {
    if (!m.clef) return;
    if (m.clef === cur && i > 0) delete m.clef;
    else cur = m.clef;
  });
}

function decomposeRests(ticks: number): MusicEvent[] {
  return decompose(ticks).map((d) => makeRest(d.duration, d.dots));
}

function normalizeIfEmpty(m: Measure, cap: number) {
  normalizeMeasure(m, cap);
}
