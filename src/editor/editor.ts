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
  ensureVoice, eventAt, eventTicks, findEvent, makeNote, makeRest, measureCapacity, measureEvents, normalizeMeasure,
  overwriteAt, reflowPart, splitRestAt, tickOfIndex, TimeSignature, voiceEvents,
} from '../model/score';
import { Interval, transposeKey, transposePitch } from '../model/transpose';

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
    this.emit('view');
  }

  setInputDuration(d: DurationType) {
    this.inputDuration = d;
    if (d === '32') this.inputDots = 0;
    // 選択中の音符があれば、その長さも変える（MuseScoreと同じ挙動）
    if (this.mode === 'select' && this.selectedId) this.setSelectedDuration(d, this.inputDots);
    else this.emit('view');
  }

  toggleDot() {
    this.inputDots = this.inputDots ? 0 : 1;
    if (this.mode === 'select' && this.selectedId) {
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
    const evs = ensureVoice(m, voice, this.capacity);
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
        const evs = voiceEvents(m, loc.voice);
        const ev = evs[loc.eventIndex];
        if (ev.kind === 'rest') continue;
        evs[loc.eventIndex] = makeRest(ev.duration, ev.dots);
        const prev = loc.eventIndex > 0 ? evs[loc.eventIndex - 1] : undefined;
        if (prev?.kind === 'note') delete prev.tie;
        touched.add(m);
      }
      for (const m of touched) normalizeMeasure(m, this.capacity);
      const first = locs[0];
      const m = this.score.parts[first.partIndex].measures[first.measureIndex];
      this.cursor = this.clampCursor({ ...first, eventIndex: first.eventIndex }, m);
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
      const voice = this.voice;
      const part = this.score.parts[partIndex];
      let total = ticksOf(this.inputDuration, this.inputDots);
      let firstId: string | null = null;
      let prevNote: NoteEvent | null = null;
      while (total > 0) {
        this.ensureMeasure(measureIndex);
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
          overwriteAt(m, eventIndex, ev, voice);
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
        ensureVoice(part.measures[measureIndex], voice, cap);
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
      const rest = makeRest(ev.duration, ev.dots);
      evs[loc.eventIndex] = rest;
      this.selectedId = rest.id;
      if (loc.eventIndex > 0) {
        const prev = evs[loc.eventIndex - 1];
        if (prev.kind === 'note') delete prev.tie;
      }
      const before = evs.length;
      normalizeIfEmpty(m, this.capacity);
      const after = voiceEvents(m, loc.voice);
      if (after !== evs || after.length !== before) this.selectedId = after[0]?.id ?? null;
      this.cursor = this.clampCursor({ ...loc }, m);
    });
  }

  setSelectedDuration(duration: DurationType, dots: number) {
    const loc = this.selectedLocation;
    if (!loc) return;
    this.mutate(() => {
      const cap = this.capacity;
      const m = this.score.parts[loc.partIndex].measures[loc.measureIndex];
      const evs = voiceEvents(m, loc.voice);
      const ev = evs[loc.eventIndex];
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
      overwriteAt(m, loc.eventIndex, replaced, loc.voice);
      this.inputDuration = duration;
      this.inputDots = dots;
    });
  }

  /** 選択中の音を五線上で上下に動かす（steps = 白鍵の数）。調号の変化に合わせる。 */
  transposeSelected(steps: number, coalesce?: string) {
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
    const evs = voiceEvents(this.score.parts[loc.partIndex].measures[loc.measureIndex], loc.voice);
    const j = loc.eventIndex + delta;
    if (j < 0 || j >= evs.length) return;
    this.mutate(() => {
      const [ev] = evs.splice(loc.eventIndex, 1);
      evs.splice(j, 0, ev);
      this.cursor = { ...loc, eventIndex: j };
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
    this.mutate(() => {
      const old = this.score.keyFifths;
      // 調号どおりだった音は新しい調号に合わせる（臨時記号付きの音はそのまま）
      for (const p of this.score.parts)
        for (const m of p.measures)
          for (const ev of measureEvents(m))
            if (ev.kind === 'note')
              ev.pitches = ev.pitches.map((q) =>
                q.alter === keyAlter(old, q.step) ? { ...q, alter: keyAlter(fifths, q.step) } : q,
              );
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
      for (const p of this.score.parts) reflowPart(p, cap);
      equalizeMeasureCounts(this.score);
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
      }
      this.score.parts.forEach((part, pi) => {
        if (scope.kind === 'part' && scope.partIndex !== pi) return;
        for (const m of part.measures)
          for (const ev of measureEvents(m)) {
            if (ev.kind !== 'note' || (ids && !ids.has(ev.id))) continue;
            ev.pitches = ev.pitches.map((p) => transposePitch(p, iv)).sort(comparePitch);
          }
      });
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
