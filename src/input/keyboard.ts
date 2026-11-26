/**
 * 画面の鍵盤（iPad向け）。複数の指で同時に押せる。
 * 押した鍵の MIDI 番号を onPress で知らせる。和音かどうかの判断は呼び出し側（main.ts）で行う。
 */

const WHITE_SEMITONES = [0, 2, 4, 5, 7, 9, 11];
const SOLFEGE = ['ド', 'レ', 'ミ', 'ファ', 'ソ', 'ラ', 'シ'];
/** 白鍵の後ろに黒鍵があるか（ド・レ・ファ・ソ・ラ） */
const HAS_BLACK_AFTER = [true, true, false, true, true, true, false];
const MIN_MIDI = 21; // A0
const MAX_MIDI = 108; // C8

export interface KeyboardOptions {
  /** 押した瞬間。held は、この鍵を押したときに他の鍵がまだ押されていたか */
  onPress(midi: number, held: boolean): void;
  onRelease?(midi: number): void;
}

export class PianoKeyboard {
  /** いちばん左の白鍵のオクターブ（その C から始める） */
  startOctave: number;
  private whiteCount = 15;
  private keys = new Map<number, HTMLElement>();
  private pointers = new Map<number, number>();

  constructor(private el: HTMLElement, private opts: KeyboardOptions, startOctave = 3) {
    this.startOctave = startOctave;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e));
    el.addEventListener('pointerleave', (e) => this.up(e));
    // 長押しでの拡大鏡・メニュー、2本指での拡大を防ぐ
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  }

  /** 幅に合わせて白鍵の数を決めて描き直す */
  layout() {
    const w = this.el.clientWidth || 800;
    const keyW = w < 600 ? 40 : 52;
    this.whiteCount = Math.max(8, Math.min(36, Math.floor(w / keyW)));
    this.clampStart();
    this.build();
  }

  get lowest() {
    return (this.startOctave + 1) * 12;
  }

  get highest() {
    let midi = this.lowest;
    let whites = 1;
    while (whites < this.whiteCount) {
      midi++;
      if (WHITE_SEMITONES.includes(midi % 12)) whites++;
    }
    return midi;
  }

  shiftOctave(delta: number) {
    this.startOctave += delta;
    this.clampStart();
    this.build();
  }

  private clampStart() {
    const octaves = this.whiteCount / 7;
    const maxStart = Math.floor((MAX_MIDI / 12 - 1) - octaves + 1);
    this.startOctave = Math.max(0, Math.min(this.startOctave, Math.max(0, maxStart)));
  }

  /** 範囲の名前（例「C3〜E5」） */
  rangeLabel() {
    const name = (m: number) => ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][m % 12] + (Math.floor(m / 12) - 1);
    return `${name(this.lowest)}〜${name(this.highest)}`;
  }

  private build() {
    this.el.innerHTML = '';
    this.keys.clear();
    this.pointers.clear();
    const wPct = 100 / this.whiteCount;
    let wi = 0;
    for (let midi = this.lowest; wi < this.whiteCount; midi++) {
      const pc = midi % 12;
      const white = WHITE_SEMITONES.indexOf(pc);
      if (white < 0) continue;
      if (midi >= MIN_MIDI && midi <= MAX_MIDI) {
        const k = document.createElement('div');
        k.className = 'key white' + (midi === 60 ? ' middle-c' : '');
        k.dataset.midi = String(midi);
        k.style.left = wi * wPct + '%';
        k.style.width = wPct + '%';
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = pc === 0 ? `C${Math.floor(midi / 12) - 1}` : SOLFEGE[white];
        if (pc === 0) label.classList.add('c');
        k.appendChild(label);
        this.el.appendChild(k);
        this.keys.set(midi, k);
        if (HAS_BLACK_AFTER[white] && wi < this.whiteCount - 1 && midi + 1 <= MAX_MIDI) {
          const b = document.createElement('div');
          b.className = 'key black';
          b.dataset.midi = String(midi + 1);
          b.style.left = (wi + 1) * wPct - wPct * 0.3 + '%';
          b.style.width = wPct * 0.6 + '%';
          this.el.appendChild(b);
          this.keys.set(midi + 1, b);
        }
      }
      wi++;
    }
  }

  private down(e: PointerEvent) {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-midi]');
    if (!t) return;
    e.preventDefault();
    const midi = Number(t.dataset.midi);
    const held = this.pointers.size > 0;
    this.pointers.set(e.pointerId, midi);
    try { this.el.setPointerCapture(e.pointerId); } catch { /* 無視 */ }
    t.classList.add('down');
    this.opts.onPress(midi, held);
  }

  private up(e: PointerEvent) {
    const midi = this.pointers.get(e.pointerId);
    if (midi === undefined) return;
    this.pointers.delete(e.pointerId);
    if (![...this.pointers.values()].includes(midi)) this.keys.get(midi)?.classList.remove('down');
    this.opts.onRelease?.(midi);
  }

  /** 再生中などに、鳴っている音の鍵を光らせる */
  highlight(midis: Set<number>) {
    for (const [m, k] of this.keys) k.classList.toggle('lit', midis.has(m));
  }
}
