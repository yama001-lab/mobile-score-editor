/**
 * 歌詞・コードネーム・文字・練習番号の入力（MuseScore と同じ流れ）。
 * - パレットの「歌詞」などを押すか、楽譜の文字をタップすると、画面の上に入力欄が出る
 * - 歌詞：スペース／Enter／「次へ」で次の音符へ（休符とタイの続きはとばす）、「-」で次の音節とハイフンでつなぐ
 *   日本語の変換中（IME）のスペース・Enter は変換に使うので、確定してから次へ進む
 * - コードネーム：スペース／Enter で次の音符・休符へ
 * - 入力欄が開いているあいだに音符をタップすると、その音符へ移る
 */
import { Editor } from '../editor/editor';
import { eventAt, findEvent } from '../model/score';
import {
  MAX_VERSES, lyricOf, nextRehearsal, partEvents, stepEventTarget, stepLyricTarget,
} from '../model/texts';
import { TextFocus, TextHit, TextKind } from '../render/texts';

interface Options {
  editor: Editor;
  rerender: () => void;
  toast: (text: string) => void;
  /** 楽譜上の点にある音符・休符の id（なければ null） */
  pick: (x: number, y: number) => string | null;
}

const LABELS: Record<TextKind, string> = { lyric: '歌詞', chord: 'コード', text: '文字', rehearsal: '練習番号' };
const PLACEHOLDERS: Record<TextKind, string> = {
  lyric: '例：さ（スペースで次へ、- でつなぐ）',
  chord: '例：C　Am7　F#m7-5　G/B',
  text: '例：rit.　やさしく',
  rehearsal: '例：A',
};

interface Target {
  kind: TextKind;
  eventId?: string;
  measureIndex?: number;
  verse: number;
}

export class TextEntry {
  private o: Options;
  private bar: HTMLDivElement;
  private input: HTMLInputElement;
  private kindLabel: HTMLSpanElement;
  private verseSel: HTMLSelectElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private target: Target | null = null;
  private composing = false;
  private buttons = new Map<TextKind, HTMLButtonElement>();
  private tap: { pointerId: number; hit?: TextHit; eventId?: string } | null = null;

  constructor(o: Options) {
    this.o = o;
    this.bar = document.createElement('div');
    this.bar.className = 'text-entry';
    this.bar.hidden = true;
    this.bar.innerHTML = `
      <span class="te-kind"></span>
      <select class="te-verse" aria-label="何番の歌詞か"></select>
      <input class="te-input" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="next" />
      <button type="button" class="te-b" data-act="prev" title="前へ (Shift+スペース)">◀ 前</button>
      <button type="button" class="te-b" data-act="next" title="次へ (スペース / Enter)">次 ▶</button>
      <button type="button" class="te-b danger" data-act="clear" title="この文字を消す">消す</button>
      <button type="button" class="te-b primary" data-act="done" title="入力を終える (Esc)">完了</button>`;
    this.kindLabel = this.bar.querySelector('.te-kind')!;
    this.verseSel = this.bar.querySelector('.te-verse')!;
    this.input = this.bar.querySelector('.te-input')!;
    this.prevBtn = this.bar.querySelector('[data-act="prev"]')!;
    this.nextBtn = this.bar.querySelector('[data-act="next"]')!;
    for (let v = 0; v < MAX_VERSES; v++) this.verseSel.add(new Option(`${v + 1}番`, String(v)));
    document.querySelector('#stage')!.appendChild(this.bar);

    // ボタンを押しても入力欄から focus を外さない（iPad でキーボードが閉じないように）
    this.bar.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) e.preventDefault();
    });
    this.bar.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]')?.dataset.act;
      if (act === 'prev') this.step(-1);
      else if (act === 'next') this.step(1);
      else if (act === 'clear') { this.input.value = ''; this.commit(); this.input.focus(); }
      else if (act === 'done') this.close();
    });
    this.verseSel.addEventListener('change', () => {
      if (!this.target) return;
      this.commit();
      this.target.verse = Number(this.verseSel.value);
      this.load();
      this.input.focus();
    });
    this.input.addEventListener('compositionstart', () => (this.composing = true));
    this.input.addEventListener('compositionend', () => {
      this.composing = false;
      this.onInput();
    });
    this.input.addEventListener('input', (e) => {
      if ((e as InputEvent).isComposing || this.composing) { this.commit(); return; }
      this.onInput();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));

    this.buildPalette();
    document.addEventListener('keydown', (e) => {
      // Ctrl/⌘ + L：歌詞、K：コードネーム、M：練習番号（MuseScore と同じ）
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if ((e.target as HTMLElement).tagName === 'INPUT' || document.querySelector('dialog[open]')) return;
      const kind = ({ l: 'lyric', k: 'chord', m: 'rehearsal' } as Record<string, TextKind>)[e.key.toLowerCase()];
      if (!kind) return;
      e.preventDefault();
      this.start(kind);
    });
    o.editor.onChange(() => {
      // 別の楽譜を開いた・元に戻したなどで対象がなくなったら閉じる
      const t = this.target;
      if (!t) return;
      if (t.eventId && !findEvent(o.editor.score, t.eventId)) this.close();
      else if (t.measureIndex !== undefined && t.measureIndex >= o.editor.score.parts[0].measures.length) this.close();
    });
  }

  get isOpen() {
    return !!this.target;
  }

  /** 描画で薄い青を付ける対象 */
  get focus(): TextFocus | null {
    const t = this.target;
    return t ? { kind: t.kind, eventId: t.eventId, measureIndex: t.measureIndex, verse: t.verse } : null;
  }

  private buildPalette() {
    const group = document.createElement('div');
    group.className = 'group';
    group.setAttribute('aria-label', '歌詞・コードネーム・文字');
    const items: [TextKind, string, string][] = [
      ['lyric', 'あ', '歌詞を入れる (Ctrl+L)。選んだ音符から順に入れていきます'],
      ['chord', 'C7', 'コードネームを入れる (Ctrl+K)'],
      ['text', 'Aa', '譜表の上に文字を書く（rit. や「やさしく」など）'],
      ['rehearsal', '[A]', '練習番号をカーソルのある小節に付ける (Ctrl+M)'],
    ];
    for (const [kind, glyph, title] of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tool txt';
      b.title = title;
      b.innerHTML = `<b></b><span></span>`;
      b.querySelector('b')!.textContent = glyph;
      b.querySelector('span')!.textContent = LABELS[kind];
      // focus は click の中で呼ぶ（iPad でキーボードを出すため）
      b.addEventListener('click', () => (this.target?.kind === kind ? this.close() : this.start(kind)));
      this.buttons.set(kind, b);
      group.appendChild(b);
    }
    document.querySelector('#palette')!.appendChild(group);
  }

  /** パレット・ショートカットから：選択中の音符（なければ入力位置）から始める */
  start(kind: TextKind) {
    const ed = this.o.editor;
    const score = ed.score;
    const part = ed.selectedLocation?.partIndex ?? ed.cursor.partIndex;
    if (kind === 'rehearsal') {
      const mi = ed.selectedLocation?.measureIndex ?? ed.cursor.measureIndex;
      this.open({ kind, measureIndex: Math.min(mi, score.parts[0].measures.length - 1), verse: 0 });
      return;
    }
    const sel = ed.selected;
    let id: string | null = null;
    if (sel && (kind !== 'lyric' || sel.kind === 'note')) id = sel.id;
    if (!id) {
      const list = partEvents(score, part);
      const c = ed.cursor;
      const at = list.findIndex((x) => x.measureIndex === c.measureIndex && x.eventIndex === c.eventIndex);
      if (kind === 'lyric') {
        // 入力位置の直前の音符（入れたばかりの音符）、なければ最初の音符
        const before = list.slice(0, at < 0 ? list.length : at).reverse().find((x) => x.ev.kind === 'note');
        id = (before ?? list.find((x) => x.ev.kind === 'note'))?.ev.id ?? null;
      } else {
        id = (list[at] ?? list[list.length - 1])?.ev.id ?? null;
      }
    }
    if (!id) { this.o.toast(kind === 'lyric' ? '先に音符を入れてから歌詞を付けてください' : '付ける場所が見つかりません'); return; }
    this.open({ kind, eventId: id, verse: kind === 'lyric' ? this.target?.verse ?? 0 : 0 });
  }

  private open(t: Target) {
    if (this.target) this.commit();
    const reopen = this.target?.kind === t.kind;
    this.target = t;
    if (t.kind === 'rehearsal' && !this.o.editor.score.parts[0].measures[t.measureIndex!]?.rehearsal) {
      // 新しい練習番号は、前にある番号の続き（A → B）を入れておく
      this.o.editor.setRehearsal(t.measureIndex!, nextRehearsal(this.o.editor.score, t.measureIndex!), 'rehearsal-new');
    }
    this.bar.hidden = false;
    this.bar.dataset.kind = t.kind;
    this.kindLabel.textContent = LABELS[t.kind];
    this.verseSel.hidden = t.kind !== 'lyric';
    this.verseSel.value = String(t.verse);
    const stepping = t.kind === 'lyric' || t.kind === 'chord';
    this.prevBtn.hidden = !stepping;
    this.nextBtn.hidden = !stepping;
    this.input.placeholder = PLACEHOLDERS[t.kind];
    this.input.enterKeyHint = stepping ? 'next' : 'done';
    this.load();
    this.buttons.forEach((b, k) => b.classList.toggle('on', k === t.kind));
    if (!reopen || document.activeElement !== this.input) this.input.focus();
    this.input.select();
  }

  close() {
    if (!this.target) return;
    this.commit();
    this.target = null;
    this.bar.hidden = true;
    this.input.blur();
    this.buttons.forEach((b) => b.classList.remove('on'));
    this.o.editor.endGesture();
    this.o.rerender();
  }

  /** 対象の今の文字を入力欄に入れ、対象の音符を選ぶ（自動スクロールと青い表示のため） */
  private load() {
    const t = this.target!;
    const ed = this.o.editor;
    ed.endGesture();
    if (t.kind === 'rehearsal') {
      this.input.value = ed.score.parts[0].measures[t.measureIndex!]?.rehearsal ?? '';
      ed.setCursor({ partIndex: 0, measureIndex: t.measureIndex!, eventIndex: 0 });
      this.o.rerender();
      return;
    }
    const loc = findEvent(ed.score, t.eventId!);
    const ev = loc && eventAt(ed.score, loc);
    if (!ev) { this.close(); return; }
    this.input.value = t.kind === 'lyric' ? lyricOf(ev, t.verse) : (ev[t.kind] ?? '');
    ed.select(ev.id);
    this.o.rerender();
  }

  /** 入力欄の文字を楽譜に入れる（1つの文字の入力は1回の「元に戻す」） */
  private commit() {
    const t = this.target;
    if (!t) return;
    const ed = this.o.editor;
    const v = this.input.value.replace(/[\s　]+$/u, '').replace(/^[\s　]+/u, '');
    const key = `text:${t.kind}:${t.eventId ?? t.measureIndex}:${t.verse}`;
    if (t.kind === 'lyric') ed.setLyric(t.eventId!, t.verse, v, key);
    else if (t.kind === 'rehearsal') ed.setRehearsal(t.measureIndex!, v, key);
    else ed.setEventText(t.eventId!, t.kind, v, key);
  }

  private onInput() {
    const t = this.target;
    if (!t) return;
    const v = this.input.value;
    // スペース（全角も）で次へ。iPad の日本語キーボードは確定後のスペースが全角になる
    if ((t.kind === 'lyric' || t.kind === 'chord') && /[ 　]$/u.test(v)) {
      this.input.value = v.replace(/[ 　]+$/u, '');
      this.step(1);
      return;
    }
    this.commit();
  }

  private onKey(e: KeyboardEvent) {
    if (e.isComposing || this.composing || e.keyCode === 229) return;
    const t = this.target;
    if (!t) return;
    const stepping = t.kind === 'lyric' || t.kind === 'chord';
    if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (stepping) this.step(e.shiftKey ? -1 : 1);
      else this.close();
      return;
    }
    if (!stepping) return;
    if (e.key === 'Tab' || (e.key === ' ' && e.shiftKey)) { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); return; }
    if (e.key === ' ') { e.preventDefault(); this.step(1); return; }
    if (t.kind === 'lyric' && e.key === '-' && this.input.value && !this.input.value.endsWith('-')) {
      // 「-」で次の音節とハイフンでつなぎ、次の音符へ
      e.preventDefault();
      this.input.value += '-';
      this.step(1);
    }
  }

  /** 次（前）の音符へ */
  step(delta: 1 | -1) {
    const t = this.target;
    if (!t?.eventId) return;
    this.commit();
    const loc = findEvent(this.o.editor.score, t.eventId);
    if (!loc) return;
    const next = t.kind === 'lyric'
      ? stepLyricTarget(this.o.editor.score, loc.partIndex, t.eventId, delta)
      : stepEventTarget(this.o.editor.score, loc.partIndex, t.eventId, delta);
    if (!next) {
      this.o.toast(delta > 0 ? '最後の音符です' : '最初の音符です');
      return;
    }
    t.eventId = next;
    this.load();
    this.input.focus();
  }

  // ---------- 楽譜のタップ（main.ts から呼ぶ） ----------

  /** pointerdown：文字の上、または入力中に音符の上なら受け持つ（true を返したら main は何もしない） */
  pointerDown(ev: PointerEvent, x: number, y: number, hits: TextHit[]): boolean {
    const hit = hits.find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
    if (hit) { this.tap = { pointerId: ev.pointerId, hit }; return true; }
    const t = this.target;
    if (t && t.kind !== 'rehearsal') {
      const id = this.o.pick(x, y);
      if (id) { this.tap = { pointerId: ev.pointerId, eventId: id }; return true; }
    }
    return false;
  }

  /** pointerup：タップした文字（音符）の入力を始める。キーボードを出すため focus はここで */
  pointerUp(ev: PointerEvent, cancelled: boolean): boolean {
    const tap = this.tap;
    if (!tap || tap.pointerId !== ev.pointerId) return false;
    this.tap = null;
    if (cancelled) return true;
    if (tap.hit) {
      const h = tap.hit;
      this.open({ kind: h.kind, eventId: h.eventId, measureIndex: h.measureIndex, verse: h.verse ?? 0 });
    } else if (tap.eventId && this.target) {
      const ev = eventAt(this.o.editor.score, findEvent(this.o.editor.score, tap.eventId)!);
      if (this.target.kind === 'lyric' && ev?.kind !== 'note') return true;
      this.open({ ...this.target, eventId: tap.eventId });
    }
    return true;
  }
}
