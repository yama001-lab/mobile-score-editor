/**
 * 手書きモードで楽譜の上に重ねる描画の層。ペン（または指）の線を集め、
 * 書き終えて少し待つと onRecognize にまとめて渡す。
 *
 * - pointerType が pen の線はいつも書く。安価なスタイラスは touch として届くので、
 *   「指でも書く」がオンのとき（既定）は1本指でも書く
 * - 2本指で触ったら書きかけの線を捨てて、楽譜をスクロールする
 * - 手のひらのような大きな接触は無視する
 */
import { Point, Stroke } from './recognize';

export interface PenLayerOptions {
  /** 楽譜の要素（この中に層を重ねる） */
  host: HTMLElement;
  /** スクロールする外側の要素 */
  scroller: HTMLElement;
  zoom: () => number;
  /** 書き終えてから読み取るまでの時間（ms） */
  delay?: number;
  /** 前の記号からこの距離（論理px）より右に書き始めたら、前の記号をすぐ読み取る */
  splitDistance?: number;
  onRecognize: (strokes: Stroke[]) => void;
}

interface Ink { stroke: Stroke; color: string; until: number }

export class PenLayer {
  readonly el: HTMLCanvasElement;
  fingerDraws = true;
  private ctx: CanvasRenderingContext2D;
  private enabled = false;
  private pending: Stroke[] = [];
  private current: { id: number; stroke: Stroke } | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private timer = 0;
  private faded: Ink[] = [];
  private fadeTimer = 0;

  constructor(private o: PenLayerOptions) {
    this.el = document.createElement('canvas');
    this.el.className = 'pen-layer';
    this.el.hidden = true;
    this.ctx = this.el.getContext('2d')!;
    const el = this.el;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e, false));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
    // iPadのSafariで、書いている間に画面が動かないようにする
    el.addEventListener('touchmove', (e) => {
      if (this.enabled && (this.current || this.fingerDraws)) e.preventDefault();
    }, { passive: false });
    this.setFingerDraws(true);
  }

  /** 指でも書くか。オフのときは指で普通にスクロールでき、ペンだけで書く */
  setFingerDraws(on: boolean) {
    this.fingerDraws = on;
    this.el.classList.toggle('finger-draws', on);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    this.el.hidden = !on;
    if (!on) { this.flush(); this.current = null; this.touches.clear(); }
    this.resize();
  }

  /** 楽譜を描き直したあとに呼ぶ（大きさを合わせて、層を楽譜の上に戻す） */
  attach() {
    if (this.el.parentElement !== this.o.host) this.o.host.appendChild(this.el);
    this.resize();
  }

  private resize() {
    if (!this.enabled) return;
    const w = this.o.host.clientWidth, h = this.o.host.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (this.el.width !== Math.round(w * dpr) || this.el.height !== Math.round(h * dpr)) {
      this.el.width = Math.round(w * dpr);
      this.el.height = Math.round(h * dpr);
      this.el.style.width = w + 'px';
      this.el.style.height = h + 'px';
    }
    this.redraw();
  }

  private point(e: PointerEvent): Point {
    const r = this.el.getBoundingClientRect();
    const z = this.o.zoom();
    return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z };
  }

  private down(e: PointerEvent) {
    if (!this.enabled) return;
    e.stopPropagation();
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // 2本目の指：書きかけを捨ててスクロールへ
      if (this.touches.size >= 2) {
        if (this.current) { this.current = null; this.redraw(); }
        return;
      }
      if (!this.fingerDraws) return;
      // 手のひら（接触面が大きい）は無視
      if ((e.width || 0) > 40 && (e.height || 0) > 40) return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.current) return;
    clearTimeout(this.timer);
    const p = this.point(e);
    // 前の記号から右に離れて書き始めたら、前の記号を先に読み取る
    const split = this.o.splitDistance ?? 22;
    if (this.pending.length) {
      const maxX = Math.max(...this.pending.flat().map((q) => q.x));
      const minX = Math.min(...this.pending.flat().map((q) => q.x));
      if (p.x > maxX + split || p.x < minX - split * 2) this.flush();
    }
    try { this.el.setPointerCapture(e.pointerId); } catch { /* 古いブラウザ */ }
    this.current = { id: e.pointerId, stroke: [p] };
  }

  private move(e: PointerEvent) {
    if (!this.enabled) return;
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      const prev = this.touches.get(e.pointerId)!;
      if (this.touches.size >= 2) {
        // 2本指の平均の動きでスクロール
        const n = this.touches.size;
        this.o.scroller.scrollBy((prev.x - e.clientX) / n, (prev.y - e.clientY) / n);
      }
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (!this.current || this.current.id !== e.pointerId) return;
    const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ce of evs.length ? evs : [e]) this.current.stroke.push(this.point(ce));
    this.redraw();
  }

  private up(e: PointerEvent, cancelled: boolean) {
    this.touches.delete(e.pointerId);
    if (!this.current || this.current.id !== e.pointerId) return;
    const st = this.current.stroke;
    this.current = null;
    if (cancelled) { this.redraw(); return; }
    this.pending.push(st);
    this.redraw();
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.flush(), this.o.delay ?? 650);
  }

  /** たまっている線をすぐ読み取る */
  flush() {
    clearTimeout(this.timer);
    if (!this.pending.length) return;
    const strokes = this.pending;
    this.pending = [];
    this.redraw();
    this.o.onRecognize(strokes);
  }

  /** 読み取れなかった線を赤で少しだけ残す */
  showRejected(strokes: Stroke[]) {
    const until = Date.now() + 1200;
    for (const st of strokes) this.faded.push({ stroke: st, color: 'rgba(220,38,38,0.75)', until });
    this.redraw();
    clearTimeout(this.fadeTimer);
    this.fadeTimer = window.setTimeout(() => this.redraw(), 1250);
  }

  private redraw() {
    const c = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const z = this.o.zoom();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.el.width, this.el.height);
    c.setTransform(dpr * z, 0, 0, dpr * z, 0, 0);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.lineWidth = 2;
    const now = Date.now();
    this.faded = this.faded.filter((f) => f.until > now);
    const draw = (st: Stroke, color: string) => {
      c.strokeStyle = color;
      c.beginPath();
      c.moveTo(st[0].x, st[0].y);
      if (st.length === 1) c.lineTo(st[0].x + 0.1, st[0].y + 0.1);
      for (const p of st) c.lineTo(p.x, p.y);
      c.stroke();
    };
    for (const f of this.faded) draw(f.stroke, f.color);
    for (const st of this.pending) draw(st, 'rgba(21,101,192,0.85)');
    if (this.current) draw(this.current.stroke, 'rgba(21,101,192,0.85)');
  }
}
