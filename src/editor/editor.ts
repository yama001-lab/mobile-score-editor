/**
 * 編集操作の窓口。画面のボタン・キーボード・（今後の）iPad鍵盤や手書き認識は、すべてここを通して楽譜を変える。
 * 各操作の前にスナップショットを取り、元に戻す／やり直しに使う。
 */
import { DurationType, decompose, ticksOf } from '../model/duration';
import {
  Pitch, comparePitch, diatonicIndex, fromDiatonic, fromMidi, keyAlter, samePitch, STEPS, Step,
} from '../model/pitch';
import {
  Clef, EventLocation, Instrument, Measure, MusicEvent, NoteEvent, Score, createMeasure, createPart, equalizeMeasureCounts,
  beatTicks, eventAt, eventTicks, findEvent, makeNote, makeRest, makeTupletGroup, measureCapacity, normalizeMeasure, overwriteAt,
  overwriteInTuplet, reflowPart, restsFor, TimeSignature, tupletRange,
} from '../model/score';
import { Articulation, Dynamic, SpannerKind } from '../model/score';
import { setDynamicOn, toggleArticulationOn, toggleSpannerAt } from '../model/marks';
import {
  Clip, RangeSel, clearRange, eventSpan, extractRange, pasteClip, rangeEnds, rangeEventIds, rangeNotes,
} from './range';

/** select=選んで直す、input=タップ・鍵盤で入れる、pen=五線に手書き */
export type Mode = 'select' | 'input' | 'pen';

export interface Cursor {
  partIndex: number;
  measureIndex: number;
  eventIndex: number;
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

  get capacity() {
    return measureCapacity(this.score.timeSignature);
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
    this.emit('view');
  }

  /** 選択を前後の音符へ移す（delta = -1 / +1） */
  moveSelection(delta: number) {
    const loc = this.selectedLocation ?? this.cursor;
    const part = this.score.parts[loc.partIndex];
    let m = loc.measureIndex;
    let e = loc.eventIndex + delta;
    while (m >= 0 && m < part.measures.length) {
      const evs = part.measures[m].events;
      if (e < 0) { m--; e = m >= 0 ? part.measures[m].events.length - 1 : 0; continue; }
      if (e >= evs.length) { m++; e = 0; continue; }
      this.select(evs[e].id);
      return;
    }
  }

  // ---------- 入力 ----------

  /** 白鍵の位置（五線上の位置）で入力。調号の変化を付ける。手書き認識でも使う想定。 */
  inputDiatonic(index: number, alter?: number | null, chord = false) {
    const p = fromDiatonic(index);
    p.alter = alter ?? keyAlter(this.score.keyFifths, p.step);
    this.inputPitches([p], chord);
  }

  /** 手書きの消しゴム：指定の音符・休符をまとめて休符に戻す（元に戻すは1回） */
  eraseEvents(ids: string[]) {
    const locs = ids.map((id) => findEvent(this.score, id)).filter((l): l is EventLocation => !!l);
    if (!locs.length) return;
    this.mutate(() => {
      const touched = new Set<Measure>();
      for (const id of ids) {
        const loc = findEvent(this.score, id);
        if (!loc) continue;
        const m = this.score.parts[loc.partIndex].measures[loc.measureIndex];
        const ev = m.events[loc.eventIndex];
        if (ev.kind === 'rest') continue;
        m.events[loc.eventIndex] = makeRest(ev.duration, ev.dots, ev.tuplet);
        const prev = loc.eventIndex > 0 ? m.events[loc.eventIndex - 1] : undefined;
        if (prev?.kind === 'note') delete prev.tie;
        touched.add(m);
      }
      for (const m of touched) normalizeMeasure(m, this.capacity);
      const first = locs[0];
      const m = this.score.parts[first.partIndex].measures[first.measureIndex];
      this.cursor = { ...first, eventIndex: Math.min(first.eventIndex, m.events.length - 1) };
      this.selectedId = null;
    });
  }

  /** MIDI番号で入力（画面の鍵盤から使う）。chord なら選択中の音符に重ねる。 */
  inputMidi(midi: number, chord = false) {
    this.inputPitches([fromMidi(midi, this.score.keyFifths)], chord);
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
    const clef = this.score.parts[this.cursor.partIndex]?.clef;
    return clef === 'bass' ? 3 : clef === 'alto' ? 4 : 4;
  }

  private previousPitch(): Pitch | null {
    const part = this.score.parts[this.cursor.partIndex];
    for (let m = this.cursor.measureIndex; m >= 0; m--) {
      const evs = part.measures[m].events;
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
    const cap = this.capacity;
    while (this.score.parts[0].measures.length <= index) {
      for (const p of this.score.parts) p.measures.push(createMeasure(cap));
    }
  }

  private placeAtCursor(pitches: Pitch[] | null) {
    this.mutate(() => this.placeAtCursorRaw(pitches));
  }

  private placeAtCursorRaw(pitches: Pitch[] | null) {
    {
      const cap = this.capacity;
      let { partIndex, measureIndex, eventIndex } = this.cursor;
      const part = this.score.parts[partIndex];
      let total = ticksOf(this.inputDuration, this.inputDots);
      let firstId: string | null = null;
      let prevNote: NoteEvent | null = null;
      this.ensureMeasure(measureIndex);
      const inTuplet = part.measures[measureIndex].events[eventIndex]?.tuplet;
      if (inTuplet) {
        // 連符の中：連符の残りに収まる長さで置く（連符の外へははみ出さない）
        const m = part.measures[measureIndex];
        const ev = overwriteInTuplet(m, eventIndex, { duration: this.inputDuration, dots: this.inputDots },
          (d) => (pitches ? makeNote(pitches, d.duration, d.dots) : makeRest(d.duration, d.dots)));
        if (ev) {
          firstId = ev.id;
          eventIndex = m.events.indexOf(ev) + 1;
        }
        total = 0;
      }
      while (total > 0) {
        this.ensureMeasure(measureIndex);
        const m = part.measures[measureIndex];
        const start = m.events.slice(0, eventIndex).reduce((s, e) => s + eventTicks(e), 0);
        if (start >= cap || eventIndex >= m.events.length) {
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
          overwriteAt(m, eventIndex, ev, beatTicks(this.score.timeSignature));
          if (!firstId) firstId = ev.id;
          prevNote = ev.kind === 'note' ? ev : null;
          eventIndex++;
        }
        total -= take;
      }
      // 小節の終わりまで来たら次の小節の頭へ。最後の小節なら新しい小節を足す。
      const cur = part.measures[measureIndex];
      if (eventIndex >= cur.events.length) {
        measureIndex++;
        eventIndex = 0;
        this.ensureMeasure(measureIndex);
      }
      this.cursor = { partIndex, measureIndex, eventIndex };
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
      const ev = m.events[loc.eventIndex];
      if (ev.kind === 'note' && ev.pitches.length > 1) {
        ev.pitches.splice(Math.min(this.selectedPitchIndex, ev.pitches.length - 1), 1);
        this.selectedPitchIndex = 0;
        return;
      }
      const rest = makeRest(ev.duration, ev.dots, ev.tuplet);
      m.events[loc.eventIndex] = rest;
      this.selectedId = rest.id;
      if (loc.eventIndex > 0) {
        const prev = m.events[loc.eventIndex - 1];
        if (prev.kind === 'note') delete prev.tie;
      }
      const before = m.events.length;
      normalizeIfEmpty(m, this.capacity);
      if (m.events.length !== before) this.selectedId = m.events[0]?.id ?? null;
      this.cursor = { ...loc, eventIndex: Math.min(loc.eventIndex, m.events.length - 1) };
    });
  }

  setSelectedDuration(duration: DurationType, dots: number) {
    const loc = this.selectedLocation;
    if (!loc) return;
    this.mutate(() => {
      const cap = this.capacity;
      const m = this.score.parts[loc.partIndex].measures[loc.measureIndex];
      const ev = m.events[loc.eventIndex];
      if (ev.tuplet) {
        // 連符の中：連符の中だけで長さを変える
        const tuplet = ev.tuplet;
        m.events.splice(loc.eventIndex, 1, ...decompose(ticksOf(ev.duration, ev.dots)).map((d) => makeRest(d.duration, d.dots, tuplet)));
        const placed = overwriteInTuplet(m, loc.eventIndex, { duration, dots }, (d) => ({ ...ev, duration: d.duration, dots: d.dots }) as MusicEvent);
        if (placed) { this.inputDuration = placed.duration; this.inputDots = placed.dots; }
        return;
      }
      const start = m.events.slice(0, loc.eventIndex).reduce((s, e) => s + eventTicks(e), 0);
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
      m.events.splice(loc.eventIndex, 1, ...decomposeRests(eventTicks(ev)));
      overwriteAt(m, loc.eventIndex, replaced, beatTicks(this.score.timeSignature));
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
        np.alter = keyAlter(this.score.keyFifths, np.step);
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
        note.pitches[i] = { ...p, alter: p.alter === alter ? keyAlter(this.score.keyFifths, p.step) : alter };
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
    const m = this.score.parts[loc.partIndex].measures[loc.measureIndex];
    const j = loc.eventIndex + delta;
    if (j < 0 || j >= m.events.length) return;
    // 連符の中と外は入れ替えない（連符の中どうしなら入れ替える）
    if ((m.events[j].tuplet || m.events[loc.eventIndex].tuplet) && m.events[j].tuplet?.id !== m.events[loc.eventIndex].tuplet?.id) return;
    this.mutate(() => {
      const [ev] = m.events.splice(loc.eventIndex, 1);
      m.events.splice(j, 0, ev);
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
    return !!this.score.parts[loc.partIndex]?.measures[loc.measureIndex]?.events[loc.eventIndex]?.tuplet;
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
    const target = m.events[loc.eventIndex];
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
    const start = m.events.slice(0, loc.eventIndex).reduce((s, e) => s + eventTicks(e), 0);
    if (start + span > this.capacity) return '小節の残りに収まりません。短い音価を選ぶか、小節の頭で作ってください';
    this.mutate(() => {
      overwriteAt(m, loc.eventIndex, group, beatTicks(this.score.timeSignature));
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
    const range = m ? tupletRange(m.events, loc.eventIndex) : null;
    if (!m || !range) return;
    this.mutate(() => {
      const [s, e] = range;
      const len = m.events.slice(s, e).reduce((x, ev) => x + eventTicks(ev), 0);
      const rests = restsFor(len);
      m.events.splice(s, e - s, ...rests);
      const prev = m.events[s - 1];
      if (prev?.kind === 'note') delete prev.tie;
      normalizeMeasure(m, this.capacity);
      this.cursor = { ...loc, eventIndex: Math.min(s, m.events.length - 1) };
      this.selectedId = m.events[this.cursor.eventIndex]?.id ?? null;
    });
  }

  /** カーソルが、loc の音符のすぐ次を指しているか */
  private cursorFollows(loc: EventLocation): boolean {
    const c = this.cursor;
    if (c.partIndex !== loc.partIndex) return false;
    const m = this.score.parts[loc.partIndex].measures[loc.measureIndex];
    if (c.measureIndex === loc.measureIndex) return c.eventIndex === loc.eventIndex + 1;
    return loc.eventIndex === m.events.length - 1 && c.measureIndex === loc.measureIndex + 1 && c.eventIndex === 0;
  }

  private chordTargets(note: NoteEvent): number[] {
    if (note.pitches.length === 1) return [0];
    return [Math.min(this.selectedPitchIndex, note.pitches.length - 1)];
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
    const cap = this.capacity;
    const n = this.score.parts[0].measures.length;
    const a = Math.max(0, Math.min(mFrom, mTo));
    const b = Math.min(n - 1, Math.max(mFrom, mTo));
    this.setRange({ partFrom: Math.min(partFrom, partTo), partTo: Math.max(partFrom, partTo), start: a * cap, end: (b + 1) * cap });
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
    let m = loc.measureIndex;
    let e = loc.eventIndex + delta;
    if (e < 0) { m--; e = m >= 0 ? part.measures[m].events.length - 1 : 0; }
    else if (e >= part.measures[m].events.length) { m++; e = 0; }
    const ev = part.measures[m]?.events[e];
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

  /** いまコピーの対象になるもの：範囲、なければ選択中の1音 */
  private copySource(): RangeSel | null {
    if (this.range) return this.range;
    if (!this.selectedId) return null;
    const s = eventSpan(this.score, this.selectedId);
    return s ? { partFrom: s.partIndex, partTo: s.partIndex, start: s.start, end: s.end } : null;
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

  /** 貼り付ける位置：範囲の頭 → 選択中の音 → 入力位置（カーソル） */
  private pasteTarget(): { partIndex: number; start: number } | null {
    if (this.range) return { partIndex: this.range.partFrom, start: this.range.start };
    if (this.selectedId && this.mode !== 'input') {
      const s = eventSpan(this.score, this.selectedId);
      if (s) return { partIndex: s.partIndex, start: s.start };
    }
    const c = this.cursor;
    const part = this.score.parts[c.partIndex];
    const m = part?.measures[c.measureIndex];
    if (!m) return null;
    let t = c.measureIndex * this.capacity;
    for (let i = 0; i < Math.min(c.eventIndex, m.events.length); i++) t += eventTicks(m.events[i]);
    return { partIndex: c.partIndex, start: t };
  }

  /** 貼り付け。貼った所を範囲として選び、入力位置はその次へ */
  paste(): boolean {
    const clip = this.clipboard;
    const at = this.pasteTarget();
    if (!clip || !at) return false;
    this.mutate(() => {
      const r = pasteClip(this.score, clip, at.partIndex, at.start);
      if (!r) return;
      if (this.mode === 'select') {
        this.range = { ...r };
        this.rangeAnchor = { ...r };
        this.afterRangeChange();
      } else {
        this.selectedId = null;
      }
      // 入力位置は貼った所のすぐ後ろ（入力モードで最後まで来たら、入力と同じく小節を足す）
      const cap = this.capacity;
      let mi = Math.floor(r.end / cap);
      if (this.mode === 'input') this.ensureMeasure(mi);
      const ms = this.score.parts[r.partFrom].measures;
      if (mi >= ms.length) { mi = ms.length - 1; this.cursor = { partIndex: r.partFrom, measureIndex: mi, eventIndex: ms[mi].events.length - 1 }; return; }
      const m = ms[mi];
      let t = mi * cap;
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
        note.pitches = note.pitches.map((p) => {
          const np = fromDiatonic(diatonicIndex(p) + steps);
          np.alter = keyAlter(this.score.keyFifths, np.step);
          return np;
        }).sort(comparePitch);
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
      for (const n of notes)
        n.pitches = n.pitches.map((p) => ({ ...p, alter: all ? keyAlter(this.score.keyFifths, p.step) : alter }));
      this.range = { ...r };
      this.rangeAnchor = { ...r };
      this.afterRangeChange(focus ?? undefined);
    });
  }

  // ---------- 小節・楽譜全体 ----------

  addMeasure(after = this.score.parts[0].measures.length - 1) {
    this.mutate(() => {
      for (const p of this.score.parts) p.measures.splice(after + 1, 0, createMeasure(this.capacity));
      for (const t of this.score.tempoMarks ?? []) if (t.measure > after) t.measure++;
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
      for (const p of this.score.parts) p.measures.splice(index, 1);
      if (this.score.tempoMarks) {
        // 消した小節のテンポ変更は次の小節へ引き継ぐ（後ろにすでにあればそちらを優先）
        const marks = this.score.tempoMarks;
        for (const t of marks) if (t.measure > index) t.measure--;
        const n = this.score.parts[0].measures.length;
        this.score.tempoMarks = marks.filter((t, i) =>
          t.measure >= 1 && t.measure < n && marks.map((u) => u.measure).lastIndexOf(t.measure) === i);
      }
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

  setTimeSignature(ts: TimeSignature) {
    this.mutate(() => {
      const oldCap = measureCapacity(this.score.timeSignature);
      this.score.timeSignature = { ...ts };
      const cap = measureCapacity(ts);
      // テンポ変更は、同じ時間位置を含む小節へ移す
      if (this.score.tempoMarks) {
        const seen = new Set<number>();
        this.score.tempoMarks = this.score.tempoMarks
          .map((t) => ({ ...t, measure: Math.floor((t.measure * oldCap) / cap) }))
          .filter((t) => t.measure >= 1 && !seen.has(t.measure) && !!seen.add(t.measure));
      }
      for (const p of this.score.parts) reflowPart(p, cap, beatTicks(ts));
      equalizeMeasureCounts(this.score);
      this.cursor = { partIndex: this.cursor.partIndex, measureIndex: 0, eventIndex: 0 };
      this.selectedId = null;
    });
  }

  addPart(clef: Clef) {
    this.mutate(() => {
      const n = this.score.parts[0].measures.length;
      this.score.parts.push(createPart(clef === 'bass' ? '左手' : '譜表' + (this.score.parts.length + 1), clef, n, this.capacity));
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
      this.score.parts[index].clef = clef;
    });
  }
}

function decomposeRests(ticks: number): MusicEvent[] {
  return decompose(ticks).map((d) => makeRest(d.duration, d.dots));
}

function normalizeIfEmpty(m: Measure, cap: number) {
  normalizeMeasure(m, cap);
}
