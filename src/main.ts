import './style.css';
import { Editor, Mode } from './editor/editor';
import { DURATION_LABELS, DurationType } from './model/duration';
import { keyLabelJa, Step, toMidi } from './model/pitch';
import {
  Clef, Instrument, Score, createScore, keyAt, keyChangeAt, measureAttrsAt, measureCapacity, tempoAt, tempoMarkAt,
  timeSigAt, timeSigChangeAt,
} from './model/score';
import { Player } from './audio/player';
import { ScheduledMark } from './audio/schedule';
import { playNote, setTuning, unlock, Voice } from './audio/synth';
import { PianoKeyboard } from './input/keyboard';
import { EventHit, MeasureHit, TempoHit, diatonicAtY } from './render/render';
import { ScoreView } from './render/view';
import { setupTranspose } from './ui/transpose';
import { applyIcons, ICONS, setIcon } from './ui/icons';
import { PenLayer } from './handwriting/pen';
import { setupMarksPalette } from './ui/marks-palette';
import { applyRecognized, staffOf } from './handwriting/apply';
import { Stroke, boxOf, clusterStrokes, recognizeCluster } from './handwriting/recognize';
import { TextEntry } from './ui/text-entry';
import { TextHit } from './render/texts';
import { deleteScore, lastScoreId, listScores, loadScore, migrate, saveScore } from './storage/local';
import {
  BackupState, LOCAL_LIMIT_BYTES, PersistState, backupAll, backupFileName, changedSinceBackup, isQuotaError,
  isStandalone, localUsageBytes, parseBackup, requestPersist, restoreBackup, saveFileToDevice, shouldRemindBackup,
} from './storage/backup';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

function initialScore(): Score {
  const id = lastScoreId();
  const s = id ? loadScore(id) : null;
  return s ?? createScore();
}

applyIcons();
const editor = new Editor(initialScore());
const scoreEl = $('#score');
const wrap = $('#score-wrap');
let hits: MeasureHit[] = [];
let tempoHits: TempoHit[] = [];
let textHits: TextHit[] = [];
let zoom = Number(safeGet('score-editor:zoom')) || 1;
/** 変わった段だけを描き直す */
const view = new ScoreView(scoreEl);

// 手書きモードで楽譜の上に重ねる層（ステップ3）
const penLayer = new PenLayer({
  host: scoreEl,
  scroller: wrap,
  zoom: () => zoom,
  onRecognize: (strokes) => handleInk(strokes),
});

function safeGet(k: string) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* 保存できない環境では無視 */ }
}

// ---------- 描画 ----------

let rafPending = false;
function requestRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    render();
  });
}

function render() {
  const avail = Math.max(320, wrap.clientWidth - 24);
  const width = Math.min(avail / zoom, 1100);
  scoreEl.style.width = width * zoom + 'px';
  const res = view.render(editor.score, {
    width,
    scale: zoom,
    selectedId: editor.selectedId,
    rangeIds: editor.rangeIds,
    selectedPitchIndex: editor.selectedPitchIndex,
    cursor: editor.mode !== 'select' && !texts.isOpen ? editor.cursor : null,
    textFocus: texts.focus,
    showBreaks: true,
  });
  hits = res.hits;
  tempoHits = res.tempoHits;
  textHits = res.textHits;
  if (playheadLayer.parentElement !== scoreEl) scoreEl.appendChild(playheadLayer);
  penLayer.attach();
  focusInputPosition();
  drawPlayhead();
  updatePalette();
  $('#zoom-label').textContent = Math.round(zoom * 100) + '%';
}

(['w', 'h', 'q', '8', '16'] as const).forEach((d) => {
  const b = document.createElement('button');
  b.className = 'tool';
  b.dataset.duration = d;
  b.innerHTML = ICONS[d];
  const cap = document.createElement('span');
  cap.textContent = d === 'w' ? '全音符' : `${DURATION_LABELS[d]}`;
  b.appendChild(cap);
  b.title = `${DURATION_LABELS[d]}音符 (${({ w: 7, h: 6, q: 5, '8': 4, '16': 3 } as Record<string, number>)[d]})`;
  b.addEventListener('click', () => editor.setInputDuration(d));
  $('#durations').appendChild(b);
});

function updatePalette() {
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
    b.classList.toggle('on', b.dataset.mode === editor.mode));
  document.querySelectorAll<HTMLButtonElement>('[data-duration]').forEach((b) =>
    b.classList.toggle('on', b.dataset.duration === editor.inputDuration));
  const sel = editor.selected;
  const isNote = sel?.kind === 'note';
  document.querySelectorAll<HTMLButtonElement>('[data-voice]').forEach((b) =>
    b.classList.toggle('on', Number(b.dataset.voice) === editor.voice));
  $('#btn-dot').classList.toggle('on', editor.inputDots > 0);
  $('#btn-chord').classList.toggle('on', editor.chordMode);
  $('#btn-tuplet').classList.toggle('on', editor.inTuplet);
  // 入力モードのタイは「直前の音とタイでつないで足す」なので、選択がなくても押せる
  $('#btn-tie').classList.toggle('on', !!(isNote && sel.tie));
  ($('#btn-tie') as HTMLButtonElement).disabled = !isNote && editor.mode !== 'input';
  const ranged = !!editor.range;
  for (const id of ['#btn-up', '#btn-down']) ($(id) as HTMLButtonElement).disabled = !isNote && !ranged;
  document.querySelectorAll<HTMLButtonElement>('[data-alter]').forEach((b) => (b.disabled = !isNote && !ranged));
  for (const id of ['#btn-left', '#btn-right']) ($(id) as HTMLButtonElement).disabled = !sel || ranged;
  ($('#btn-delete') as HTMLButtonElement).disabled = !sel && !ranged;
  $('#btn-range').classList.toggle('on', rangeTapMode && editor.mode === 'select');
  for (const id of ['#btn-copy', '#btn-cut']) ($(id) as HTMLButtonElement).disabled = !editor.canCopy;
  ($('#btn-paste') as HTMLButtonElement).disabled = !editor.canPaste;
  ($('#btn-undo') as HTMLButtonElement).disabled = !editor.canUndo;
  ($('#btn-redo') as HTMLButtonElement).disabled = !editor.canRedo;
  scoreEl.classList.toggle('input-mode', editor.mode === 'input');
  scoreEl.classList.toggle('pen-mode', editor.mode === 'pen');
  $('#pen-tools').hidden = editor.mode !== 'pen';
  $('#btn-finger').classList.toggle('on', penLayer.fingerDraws);
  const title = $<HTMLInputElement>('#title');
  if (document.activeElement !== title) title.value = editor.score.title;
  const hintKey = `${editor.mode}:${panelShown()}:${editor.voice}`;
  if (hintKey !== lastHintKey) {
    lastHintKey = hintKey;
    showHint(editor.mode === 'pen'
      ? '手書き：五線に音符を書くと、少し待って音符に変わります。白丸＝全、白丸＋棒＝2分、黒丸＋棒＝4分、旗で8分・16分。こすると消えます。2本指でスクロール'
      : editor.mode === 'input'
      ? (editor.voice
        ? '声部2：符尾が下の音を、緑の帯の位置に入れます。声部1に戻すには「声部1」'
        : panelShown()
        ? '入力：鍵盤を押すと青い帯の位置に入ります。押さえたまま別の鍵で和音。五線のタップでも入ります'
        : '入力：五線をタップすると、その高さの音符が入ります')
      : '選択：音符をタップして選び、上下にドラッグで高さを変えます。長押ししてなぞると範囲を選べます');
  }
}

let lastHintKey = '';
let hintTimer = 0;
/** モードの説明は、同じ説明につき2回まで。楽譜の上の端に小さく出し、タップで閉じる */
function showHint(text: string) {
  const countKey = `score-editor:hint:${lastHintKey}`;
  const shown = Number(safeGet(countKey) ?? 0);
  if (shown >= 2) return;
  safeSet(countKey, String(shown + 1));
  const h = $('#hint');
  h.textContent = text;
  h.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => h.classList.remove('show'), 3000);
}
$('#hint').addEventListener('click', () => {
  clearTimeout(hintTimer);
  $('#hint').classList.remove('show');
});

let toastTimer = 0;
function toast(text: string, ms = 3500) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  $('#hint').classList.remove('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

// ---------- 歌詞・コードネーム・文字（src/ui/text-entry.ts） ----------

const texts = new TextEntry({
  editor,
  rerender: requestRender,
  toast: (t) => toast(t),
  pick: (x, y) => {
    const h = hitAt(x, y);
    return h ? h.events[eventIndexAt(h, x)]?.id ?? null : null;
  },
});

// ---------- 保存 ----------

let saveTimer = 0;
let saveErrorShown = false;
// 閉じる・別のアプリへ切り替える直前に、待っている保存をすぐ済ませる（iPad はタブがそのまま消えることがある）
function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  try { saveScore(editor.score); statusEl.textContent = '保存済み'; } catch { /* 下の通知に任せる */ }
}
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
const statusEl = $('#save-status');
editor.onChange((reason) => {
  requestRender();
  if (reason === 'score') {
    statusEl.textContent = '保存中…';
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      try {
        saveScore(editor.score);
        statusEl.textContent = '保存済み';
        statusEl.classList.remove('error');
      } catch (err) {
        statusEl.textContent = '保存できませんでした';
        statusEl.classList.add('error');
        if (!saveErrorShown) {
          saveErrorShown = true;
          showBackupBanner(isQuotaError(err)
            ? 'ブラウザの保存場所がいっぱいで保存できません。バックアップを取ってから、使わない楽譜を消してください。'
            : 'この楽譜をブラウザに保存できませんでした。念のためバックアップを取ってください。');
        }
      }
    }, 400);
  }
});

// ---------- タップ・ペン操作 ----------

function localPoint(ev: PointerEvent) {
  const r = scoreEl.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / zoom, y: (ev.clientY - r.top) / zoom };
}

function hitAt(x: number, y: number): MeasureHit | null {
  let best: MeasureHit | null = null;
  let bestDist = Infinity;
  for (const h of hits) {
    if (x < h.x0 || x > h.x1) continue;
    const top = h.topLineY;
    const bottom = top + h.lineSpacing * 4;
    const d = y < top ? top - y : y > bottom ? y - bottom : 0;
    if (d < 45 && d < bestDist) { best = h; bestDist = d; }
  }
  return best;
}

function eventIndexAt(h: MeasureHit, x: number) {
  const i = h.events.findIndex((e) => x >= e.left && x < e.right);
  return i >= 0 ? i : h.events.length - 1;
}

/** 声部をまたいで、タップした位置の音符・休符（横の範囲に入るもののうち、頭がいちばん近いもの） */
function pickEvent(h: MeasureHit, x: number, y: number): EventHit | null {
  let best: EventHit | null = null;
  let bd = Infinity;
  for (const list of h.voices) {
    for (const e of list) {
      if (x < e.left || x >= e.right) continue;
      const d = Math.min(...e.headYs.map((hy) => Math.abs(hy - y)));
      if (d < bd) { bd = d; best = e; }
    }
  }
  return best ?? h.events[eventIndexAt(h, x)] ?? null;
}

/** 声部2に入れるときの位置：タップより左で、どちらかの声部の音が始まるいちばん近い拍 */
function tickAt(h: MeasureHit, x: number): number {
  let best: EventHit | null = null;
  for (const e of h.voices.flat()) {
    if (e.x > x + 12) continue;
    if (!best || e.x > best.x) best = e;
  }
  return best?.tick ?? 0;
}

let drag: {
  pointerId: number; startX: number; startY: number; moved: boolean; onSelected: boolean; hit: MeasureHit;
  /** 長押しで始めた範囲選択のなぞり中 */
  range?: boolean;
} | null = null;
/** 「範囲」ボタンがオンのとき、タップで範囲を広げる */
let rangeTapMode = false;
let longPressTimer = 0;
const LONG_PRESS_MS = 450;

scoreEl.addEventListener('pointerdown', (ev) => {
  if (ev.button > 0 || editor.mode === 'pen') return;
  const { x, y } = localPoint(ev);
  if (texts.pointerDown(ev, x, y, textHits)) return;
  const th = tempoHits.find((t) => x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h);
  if (th) { tempoTap = { pointerId: ev.pointerId, measure: th.measure }; return; }
  const h = hitAt(x, y);
  if (!h) return;
  const idx = eventIndexAt(h, x);
  const e = h.events[idx];
  const onSelected = !!e && e.id === editor.selectedId && editor.mode === 'select';
  drag = { pointerId: ev.pointerId, startX: x, startY: y, moved: false, onSelected, hit: h };
  if (onSelected) scoreEl.setPointerCapture(ev.pointerId);
  // 選択モードで長押し → そのままなぞって範囲選択
  clearTimeout(longPressTimer);
  if (editor.mode === 'select' && e) {
    const pointerId = ev.pointerId;
    longPressTimer = window.setTimeout(() => {
      if (!drag || drag.pointerId !== pointerId || drag.moved) return;
      drag.range = true;
      rangeTouch = ev.pointerType === 'touch';
      try { scoreEl.setPointerCapture(pointerId); } catch { /* 指がもう離れている */ }
      editor.selectRange(e.id, e.id);
      showHint('指を動かして範囲を広げます');
    }, LONG_PRESS_MS);
  }
});

scoreEl.addEventListener('pointermove', (ev) => {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const { x, y } = localPoint(ev);
  if (drag.range) {
    const h = hitAt(x, y);
    const e = h?.events[eventIndexAt(h, x)];
    if (e) editor.extendSelectionTo(e.id);
    return;
  }
  if (Math.abs(y - drag.startY) > 4) drag.moved = true;
  if (Math.abs(x - drag.startX) > 8) { drag.moved = true; clearTimeout(longPressTimer); }
  if (drag.moved) clearTimeout(longPressTimer);
  if (drag.onSelected && drag.moved) editor.moveSelectedTo(diatonicAtY(drag.hit, y));
});

// ドラッグ中は画面がスクロールしないようにする（iPadのSafari向け）
scoreEl.addEventListener('touchmove', (ev) => {
  if (drag?.onSelected || drag?.range || rangeTouch) ev.preventDefault();
  // 指の長押しなぞりは touch で追う（ブラウザがスクロールを始めて pointercancel が来ても続けられるように）
  if (rangeTouch && ev.touches[0]) {
    const r = scoreEl.getBoundingClientRect();
    const x = (ev.touches[0].clientX - r.left) / zoom;
    const y = (ev.touches[0].clientY - r.top) / zoom;
    const h = hitAt(x, y);
    const e = h?.events[eventIndexAt(h, x)];
    if (e) editor.extendSelectionTo(e.id);
  }
}, { passive: false });
const endRangeTouch = () => { rangeTouch = false; };
scoreEl.addEventListener('touchend', endRangeTouch);
scoreEl.addEventListener('touchcancel', endRangeTouch);
/** 指の長押しで範囲選択をなぞっている間 true */
let rangeTouch = false;

let tempoTap: { pointerId: number; measure: number } | null = null;

function endPointer(ev: PointerEvent, cancelled: boolean) {
  if (texts.pointerUp(ev, cancelled)) return;
  if (tempoTap && tempoTap.pointerId === ev.pointerId) {
    const m = tempoTap.measure;
    tempoTap = null;
    if (!cancelled) openTempo(m);
    return;
  }
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  clearTimeout(longPressTimer);
  editor.endGesture();
  if (d.range) return;
  if (cancelled || d.moved) return;
  const { x, y } = localPoint(ev);
  const h = hitAt(x, y) ?? d.hit;
  const idx = eventIndexAt(h, x);
  if (editor.mode === 'input' && editor.voice) {
    // 声部2：タップした拍の位置に入れる（和音モードなら声部2の音符に重ねる）
    const pos = diatonicAtY(h, y);
    const tapped = pickEvent(h, x, y);
    const tappedEv = tapped && tapped.voice === editor.voice
      ? editor.score.parts[h.partIndex].measures[h.measureIndex].voice2?.[tapped.eventIndex] : undefined;
    if ((editor.chordMode || ev.shiftKey) && tapped && tappedEv?.kind === 'note') {
      editor.select(tapped.id);
      editor.inputDiatonic(pos, null, true);
    } else {
      editor.setCursorAtTick(h.partIndex, h.measureIndex, editor.voice, tickAt(h, x));
      editor.inputDiatonic(pos);
    }
    previewSelected(pos);
  } else if (editor.mode === 'input') {
    const pos = diatonicAtY(h, y);
    const tapped = h.events[idx];
    const tappedNote = tapped && editor.score.parts[h.partIndex].measures[h.measureIndex].events[idx]?.kind === 'note';
    if ((editor.chordMode || ev.shiftKey) && tappedNote) {
      // 和音：タップした音符に重ね、カーソルはその次へ
      editor.select(tapped.id);
      if (ev.shiftKey && !editor.chordMode) {
        editor.toggleChordMode(); editor.inputDiatonic(pos); editor.toggleChordMode();
      } else editor.inputDiatonic(pos);
      const atEnd = idx + 1 >= h.events.length && h.measureIndex + 1 < editor.score.parts[0].measures.length;
      editor.setCursor({ partIndex: h.partIndex, measureIndex: h.measureIndex + (atEnd ? 1 : 0), eventIndex: atEnd ? 0 : idx + 1 });
      previewSelected(pos);
      return;
    } else if (!(editor.chordMode || ev.shiftKey) || editor.selected?.kind !== 'note') {
      editor.setCursor({ partIndex: h.partIndex, measureIndex: h.measureIndex, eventIndex: idx });
    }
    if (ev.shiftKey && !editor.chordMode) {
      editor.toggleChordMode();
      editor.inputDiatonic(pos);
      editor.toggleChordMode();
    } else editor.inputDiatonic(pos);
    previewSelected(pos);
  } else {
    const e = pickEvent(h, x, y);
    if (!e) return;
    let pi = 0;
    if (e.headYs.length > 1) {
      let bd = Infinity;
      e.headYs.forEach((hy, i) => { const dd = Math.abs(hy - y); if (dd < bd) { bd = dd; pi = i; } });
      // VexFlowの getYs() は低い音から順
    }
    if ((ev.shiftKey || rangeTapMode) && editor.selectedId) editor.extendSelectionTo(e.id);
    else editor.select(e.id, pi);
  }
}
scoreEl.addEventListener('pointerup', (ev) => endPointer(ev, false));
scoreEl.addEventListener('pointercancel', (ev) => endPointer(ev, true));

// ---------- ボタン ----------

const on = (sel: string, fn: () => void) => $(sel).addEventListener('click', fn);
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
  b.addEventListener('click', () => {
    const m = b.dataset.mode;
    setMode(m as Mode);
  }));

function setMode(m: Mode) {
  if (m !== 'select') rangeTapMode = false;
  editor.setMode(m);
  penLayer.setEnabled(m === 'pen');
}

on('#btn-finger', () => {
  penLayer.setFingerDraws(!penLayer.fingerDraws);
  safeSet('score-editor:finger-draws', penLayer.fingerDraws ? '1' : '0');
  toast(penLayer.fingerDraws ? '指でも書けます（2本指でスクロール）' : 'ペンだけで書きます（指でスクロール）');
  updatePalette();
});
if (safeGet('score-editor:finger-draws') === '0') penLayer.setFingerDraws(false);
on('#btn-pen-help', () => $<HTMLDialogElement>('#dlg-pen-help').showModal());
setupMarksPalette(editor, { onMessage: (t) => toast(t) });

// ---------- 手書きの読み取り ----------

function handleInk(strokes: Stroke[]) {
  const s0 = hits[0]?.lineSpacing ?? 10;
  const rejected: Stroke[] = [];
  let message = '';
  for (const group of clusterStrokes(strokes, s0)) {
    const b = boxOf(group.flat());
    const h = hitAt((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
    if (!h) { rejected.push(...group); message = '五線の上か近くに書いてください'; continue; }
    const r = recognizeCluster(group, staffOf(h));
    // 大譜表では、頭のある五線を使う
    const target = r.kind === 'note' ? (hitAt(r.headX, r.headY) ?? h) : h;
    const res = applyRecognized(editor, r, target, hits);
    if (!res.ok) rejected.push(...group);
    if (res.message) message = res.message;
    if (res.ok && r.kind === 'note') previewSelected(diatonicAtY(target, r.headY));
    // 次の記号のために、描き直して位置を取り直す
    render();
  }
  if (rejected.length) penLayer.showRejected(rejected);
  if (message) toast(message);
}
document.querySelectorAll<HTMLButtonElement>('[data-alter]').forEach((b) =>
  b.addEventListener('click', () => editor.setSelectedAccidental(Number(b.dataset.alter))));
document.querySelectorAll<HTMLButtonElement>('[data-voice]').forEach((b) =>
  b.addEventListener('click', () => {
    if (editor.mode === 'select') setMode('input');
    editor.setVoice(Number(b.dataset.voice));
  }));
on('#btn-dot', () => editor.toggleDot());
on('#btn-rest', () => editor.inputRest());
on('#btn-tie', () => { editor.toggleTie(); previewSelected(); });
on('#btn-chord', () => editor.toggleChordMode());
on('#btn-up', () => editor.transposeSelected(1));
on('#btn-down', () => editor.transposeSelected(-1));
on('#btn-left', () => editor.shiftSelected(-1));
on('#btn-right', () => editor.shiftSelected(1));
on('#btn-delete', () => editor.deleteSelected());

// ---------- 範囲選択・コピー・貼り付け ----------

function copyNow(cut = false) {
  const ok = cut ? editor.cut() : editor.copy();
  if (ok) toast(cut ? '切り取りました。貼り付けたい音を選んで「貼り付け」' : 'コピーしました。貼り付けたい音を選んで「貼り付け」', 2500);
}
function pasteNow() {
  if (!editor.clipboard) { toast('先に範囲を選んでコピーしてください'); return; }
  if (!editor.paste()) toast('貼り付ける位置の音を選んでください');
}
on('#btn-range', () => {
  if (editor.mode !== 'select') setMode('select');
  rangeTapMode = !rangeTapMode;
  if (rangeTapMode) toast(editor.selectedId ? 'タップした音までを範囲にします' : '始めの音、終わりの音の順にタップしてください');
  updatePalette();
});
on('#btn-copy', () => copyNow());
on('#btn-cut', () => copyNow(true));
on('#btn-paste', pasteNow);
on('#btn-select-measure', () => {
  setMode('select');
  const c = editor.cursor;
  editor.selectMeasures(c.partIndex, c.partIndex, c.measureIndex, c.measureIndex);
});
on('#btn-select-all', () => { setMode('select'); editor.selectAll(); });
on('#btn-undo', () => editor.undo());
on('#btn-redo', () => editor.redo());
on('#btn-zoom-in', () => setZoom(zoom * 1.15));
on('#btn-zoom-out', () => setZoom(zoom / 1.15));
on('#zoom-label', () => setZoom(1));

let exporting = false;
async function exportPdfNow() {
  if (exporting) return;
  exporting = true;
  const label = $('#btn-pdf span');
  label.textContent = '作成中…';
  try {
    const { exportPdf } = await import('./export/pdf');
    await exportPdf(editor.score);
  } catch (e) {
    alert('PDFを作れませんでした: ' + (e as Error).message);
  } finally {
    exporting = false;
    label.textContent = 'PDF';
  }
}
on('#btn-pdf', exportPdfNow);

// ---------- 小節メニュー ----------

const measureMenu = $('#measure-menu');
function closeMenu() { measureMenu.hidden = true; }
on('#btn-measure-menu', () => {
  if (!measureMenu.hidden) { closeMenu(); return; }
  measureMenu.hidden = false;
  const r = $('#btn-measure-menu').getBoundingClientRect();
  const m = measureMenu.getBoundingClientRect();
  measureMenu.style.left = Math.max(8, Math.min(r.right - m.width, window.innerWidth - m.width - 8)) + 'px';
  measureMenu.style.top = Math.max(8, r.top - m.height - 8) + 'px';
});
document.addEventListener('pointerdown', (e) => {
  const t = e.target as HTMLElement;
  if (!measureMenu.hidden && !t.closest('#measure-menu, #btn-measure-menu')) closeMenu();
}, { capture: true });
measureMenu.addEventListener('click', () => closeMenu());
on('#btn-add-measure', () => editor.addMeasure());

// ---------- 連符メニュー ----------

const tupletMenu = $('#tuplet-menu');
function closeTupletMenu() { tupletMenu.hidden = true; }
on('#btn-tuplet', () => {
  if (!tupletMenu.hidden) { closeTupletMenu(); return; }
  ($('#btn-remove-tuplet') as HTMLButtonElement).disabled = !editor.inTuplet;
  tupletMenu.hidden = false;
  const r = $('#btn-tuplet').getBoundingClientRect();
  const m = tupletMenu.getBoundingClientRect();
  tupletMenu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.width - 8)) + 'px';
  tupletMenu.style.top = Math.max(8, r.top - m.height - 8) + 'px';
});
document.addEventListener('pointerdown', (e) => {
  const t = e.target as HTMLElement;
  if (!tupletMenu.hidden && !t.closest('#tuplet-menu, #btn-tuplet')) closeTupletMenu();
}, { capture: true });
tupletMenu.addEventListener('click', () => closeTupletMenu());
function makeTuplet(n: number) {
  const err = editor.createTuplet(n);
  if (err) toast(err);
}
document.querySelectorAll<HTMLButtonElement>('[data-tuplet]').forEach((b) =>
  b.addEventListener('click', () => makeTuplet(Number(b.dataset.tuplet))));
on('#btn-remove-tuplet', () => editor.removeTuplet());
on('#btn-insert-measure', () => editor.addMeasure(editor.cursor.measureIndex - 1));
on('#btn-remove-measure', () => editor.removeMeasure());
on('#btn-meter', () => openSettings());
on('#btn-toggle-break', () => {
  const mi = (editor.mode === 'select' ? editor.selectedLocation?.measureIndex : undefined) ?? editor.cursor.measureIndex;
  editor.toggleSystemBreak(mi);
  const a = measureAttrsAt(editor.score, mi);
  toast(a?.systemBreak ? `${mi + (editor.score.pickup ? 0 : 1)}小節目のあとで改行します` : '改行を外しました');
});
on('#btn-measure-marks', () => openMeasureMarks(
  (editor.mode === 'select' ? editor.selectedLocation?.measureIndex : undefined) ?? editor.cursor.measureIndex));


function setZoom(z: number) {
  zoom = Math.min(2.5, Math.max(0.5, z));
  safeSet('score-editor:zoom', String(zoom));
  requestRender();
}

const titleInput = $<HTMLInputElement>('#title');
titleInput.addEventListener('change', () => editor.updateMeta({ title: titleInput.value.trim() || '無題の楽譜' }));
titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') titleInput.blur(); });

// ---------- キーボード（PC・外付けキーボード向け） ----------

const DURATION_KEYS: Record<string, DurationType> = { '3': '16', '4': '8', '5': 'q', '6': 'h', '7': 'w' };
document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  if (mod && k.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) editor.redo(); else editor.undo(); return; }
  if (mod && k.toLowerCase() === 'y') { e.preventDefault(); editor.redo(); return; }
  if (mod && k.toLowerCase() === 'c') { e.preventDefault(); copyNow(); return; }
  if (mod && k.toLowerCase() === 'x') { e.preventDefault(); copyNow(true); return; }
  if (mod && k.toLowerCase() === 'v') { e.preventDefault(); pasteNow(); return; }
  if (mod && k.toLowerCase() === 'a') { e.preventDefault(); setMode('select'); editor.selectAll(); return; }
  // Ctrl+2〜6：連符（MuseScore と同じ）
  if (e.ctrlKey && /^[2-6]$/.test(k)) { e.preventDefault(); makeTuplet(Number(k)); return; }
  if (mod) return;
  if (k === ' ') { e.preventDefault(); togglePlay(); return; }
  if (/^[a-gA-G]$/.test(k)) {
    if (editor.mode !== 'input') setMode('input');
    if (e.shiftKey && editor.selected?.kind === 'note') {
      editor.toggleChordMode(); editor.inputStep(k.toUpperCase() as Step); editor.toggleChordMode();
    } else editor.inputStep(k.toUpperCase() as Step);
    return;
  }
  if (DURATION_KEYS[k]) { editor.setInputDuration(DURATION_KEYS[k]); return; }
  switch (k) {
    case 'n': case 'N': setMode(editor.mode === 'input' ? 'select' : 'input'); break;
    case 'p': case 'P': setMode(editor.mode === 'pen' ? 'input' : 'pen'); break;
    case 'Escape': if (editor.range) editor.clearRange(); else setMode('select'); break;
    case '.': editor.toggleDot(); break;
    case '0': editor.inputRest(); break;
    case 't': case 'T': editor.toggleTie(); break;
    case 'ArrowUp': e.preventDefault(); editor.transposeSelected(e.shiftKey ? 7 : 1); break;
    case 'ArrowDown': e.preventDefault(); editor.transposeSelected(e.shiftKey ? -7 : -1); break;
    case 'ArrowLeft': e.preventDefault(); if (e.shiftKey) editor.extendByStep(-1); else editor.moveSelection(-1); break;
    case 'ArrowRight': e.preventDefault(); if (e.shiftKey) editor.extendByStep(1); else editor.moveSelection(1); break;
    case 'Delete': case 'Backspace': e.preventDefault(); editor.deleteSelected(); break;
    case '+': editor.setSelectedAccidental(1); break;
    case '-': editor.setSelectedAccidental(-1); break;
    case '=': editor.setSelectedAccidental(0); break;
  }
});

// ---------- 楽譜一覧 ----------

const dlgList = $<HTMLDialogElement>('#dlg-list');
function openList() {
  const ul = $('#score-list');
  ul.innerHTML = '';
  for (const s of listScores()) {
    const li = document.createElement('li');
    if (s.id === editor.score.id) li.className = 'current';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.title;
    const small = document.createElement('small');
    small.textContent = new Date(s.updatedAt).toLocaleString('ja-JP');
    name.appendChild(small);
    name.addEventListener('click', () => {
      const sc = loadScore(s.id);
      if (sc) { editor.load(sc); saveScore(sc); }
      dlgList.close();
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pb danger';
    del.textContent = '削除';
    del.addEventListener('click', () => {
      if (!confirm(`「${s.title}」を削除しますか？`)) return;
      deleteScore(s.id);
      if (s.id === editor.score.id) {
        const next = listScores()[0];
        const sc = next ? loadScore(next.id) : null;
        editor.load(sc ?? createScore());
        saveScore(editor.score);
      }
      openList();
    });
    li.append(name, del);
    ul.appendChild(li);
  }
  updateBackupStatus();
  if (!dlgList.open) dlgList.showModal();
}
on('#btn-list', openList);
function newScore(grand: boolean) {
  const s = createScore({ grandStaff: grand });
  saveScore(s);
  editor.load(s);
  setMode('input');
  dlgList.close();
}
on('#btn-new-single', () => newScore(false));
on('#btn-new-grand', () => newScore(true));
on('#btn-export-pdf', () => { dlgList.close(); exportPdfNow(); });
const dlgImportHelp = $<HTMLDialogElement>('#dlg-import-help');
function openImportHelp(reason?: 'pdf' | 'image') {
  const r = $('#import-help-reason');
  r.hidden = !reason;
  r.textContent = reason === 'pdf'
    ? 'このPDFには楽譜データが入っていないため、そのままでは読み取れません。下の手順で MusicXML にしてから取り込んでください。'
    : reason === 'image' ? '写真の楽譜はそのままでは読み取れません。下の手順で MusicXML にしてから取り込んでください。' : '';
  dlgImportHelp.showModal();
}
on('#btn-import-help', () => openImportHelp());
$<HTMLInputElement>('#file-import-score').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const { importFile } = await import('./import/index');
    const r = await importFile(file);
    if (r.kind === 'needs-omr') { dlgList.close(); openImportHelp(r.reason); return; }
    r.score.id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    r.score.updatedAt = Date.now();
    saveScore(r.score);
    editor.load(r.score);
    dlgList.close();
    const what = r.source === 'pdf' ? 'PDFから楽譜を戻しました' : r.source === 'musicxml' ? 'MusicXMLを取り込みました' : '楽譜を開きました';
    toast(r.warnings.length ? `${what}。注意：${r.warnings.join('／')}` : `${what}（${r.score.parts[0].measures.length}小節）`, r.warnings.length ? 9000 : 3500);
  } catch (err) {
    alert('取り込めませんでした: ' + (err as Error).message);
  }
});
on('#btn-export-musicxml', async () => {
  const { toMusicXml } = await import('./export/musicxml');
  const blob = new Blob([toMusicXml(editor.score)], { type: 'application/vnd.recordare.musicxml+xml' });
  await saveFileToDevice(blob, safeFileName(editor.score.title) + '.musicxml');
});
on('#btn-export-json', () => {
  const blob = new Blob([JSON.stringify(editor.score, null, 1)], { type: 'application/json' });
  void saveFileToDevice(blob, safeFileName(editor.score.title) + '.json');
});
function safeFileName(title: string) {
  return (title || 'score').replace(/[\\/:*?"<>|]/g, '_');
}
$<HTMLInputElement>('#file-import').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const s = migrate(JSON.parse(await file.text()));
    s.id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    saveScore(s);
    editor.load(s);
    dlgList.close();
  } catch (err) {
    alert('読み込めませんでした: ' + (err as Error).message);
  }
});

// ---------- 保存の安全策（src/storage/backup.ts） ----------

const BACKUP_AT_KEY = 'score-editor:backup-at';
const REMINDED_AT_KEY = 'score-editor:backup-reminded-at';
const FIRST_USE_KEY = 'score-editor:first-use-at';
let persistState: PersistState = 'unsupported';

function backupState(): BackupState {
  let first = Number(safeGet(FIRST_USE_KEY)) || 0;
  if (!first) { first = Date.now(); safeSet(FIRST_USE_KEY, String(first)); }
  return {
    backupAt: Number(safeGet(BACKUP_AT_KEY)) || 0,
    remindedAt: Number(safeGet(REMINDED_AT_KEY)) || 0,
    firstUseAt: first,
  };
}

function updateBackupStatus() {
  const el = $('#backup-status');
  const st = backupState();
  const list = listScores();
  const changed = changedSinceBackup(list, st.backupAt);
  const lines: string[] = [];
  lines.push(st.backupAt
    ? `最後のバックアップ：${new Date(st.backupAt).toLocaleString('ja-JP')}`
      + (changed ? `（そのあと${changed}曲を書き換え）` : '（そのあとの変更なし）')
    : 'まだバックアップしていません。');
  if (persistState === 'persisted') lines.push('ブラウザに「消さないで」と頼んであります。');
  else if (!isStandalone()) lines.push('Safari では、しばらく開かないとデータが消えることがあります。共有メニューの「ホーム画面に追加」から開くと消えにくくなります。');
  const used = localUsageBytes();
  const ratio = used / LOCAL_LIMIT_BYTES;
  if (ratio > 0.1) lines.push(`保存場所の使用量：約${(used / 1024 / 1024).toFixed(1)}MB／5MB`);
  el.textContent = lines.join('\n');
  el.style.whiteSpace = 'pre-line';
  el.classList.toggle('warn', !st.backupAt || changed > 0 || ratio > 0.8);
}

async function backupNow() {
  try {
    saveScore(editor.score);
  } catch { /* 今の楽譜は下で直接まとめる */ }
  const data = backupAll();
  if (!data.scores.some((s) => s.id === editor.score.id)) data.scores.push(editor.score);
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const ok = await saveFileToDevice(blob, backupFileName());
  if (!ok) return;
  safeSet(BACKUP_AT_KEY, String(Date.now()));
  hideBackupBanner();
  updateBackupStatus();
  toast(`${data.scores.length}曲をバックアップしました。保存したファイルは「バックアップから戻す」で開けます。`, 5000);
}

function showBackupBanner(text: string) {
  $('#backup-banner-text').textContent = text;
  $('#backup-banner').hidden = false;
}
function hideBackupBanner() { $('#backup-banner').hidden = true; }

function maybeRemindBackup() {
  const st = backupState();
  const latest = listScores()[0]?.updatedAt ?? 0;
  if (!shouldRemindBackup(st, latest)) return;
  safeSet(REMINDED_AT_KEY, String(Date.now()));
  const n = changedSinceBackup(listScores(), st.backupAt);
  showBackupBanner(st.backupAt
    ? `前のバックアップから1週間以上たち、${n}曲が書き換わっています。バックアップしておきましょう。`
    : 'まだバックアップがありません。ブラウザのデータが消えても戻せるよう、ファイルに保存しておきましょう。');
}

on('#btn-backup', backupNow);
on('#btn-banner-backup', backupNow);
on('#btn-banner-later', () => { safeSet(REMINDED_AT_KEY, String(Date.now())); hideBackupBanner(); });
$<HTMLInputElement>('#file-restore').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const scores = parseBackup(await file.text());
    const r = restoreBackup(scores);
    // 開いている楽譜がバックアップで新しくなったら開き直す
    const cur = loadScore(editor.score.id);
    if (cur && cur.updatedAt > editor.score.updatedAt) editor.load(cur);
    openList();
    const parts = [`${r.added}曲を追加`];
    if (r.updated) parts.push(`${r.updated}曲を新しい版に更新`);
    if (r.skipped) parts.push(`${r.skipped}曲はこちらの方が新しいのでそのまま`);
    toast(`バックアップから戻しました：${parts.join('、')}`, 6000);
  } catch (err) {
    alert('戻せませんでした: ' + (isQuotaError(err) ? 'ブラウザの保存場所がいっぱいです' : (err as Error).message));
  }
});

// ---------- 設定 ----------

const dlgSet = $<HTMLDialogElement>('#dlg-settings');
const beatsSel = $<HTMLSelectElement>('#set-beats');
[2, 3, 4, 5, 6, 7, 9, 12].forEach((n) => beatsSel.add(new Option(String(n), String(n))));
const perSystemSel = $<HTMLSelectElement>('#set-per-system');
for (let n = 1; n <= 8; n++) perSystemSel.add(new Option(`${n}小節`, String(n)));
const keySel = $<HTMLSelectElement>('#set-key');
for (let f = -7; f <= 7; f++) {
  const label = f === 0 ? '調号なし（ハ長調／イ短調）' : `${Math.abs(f)}${f > 0 ? '♯' : '♭'}（${keyLabelJa(f)}）`;
  keySel.add(new Option(label, String(f)));
}
let pendingClefs: { clef: Clef; instrument: Instrument; remove: boolean; isNew: boolean }[] = [];

function renderPartList() {
  const ul = $('#part-list');
  ul.innerHTML = '';
  pendingClefs.forEach((p, i) => {
    if (p.remove) return;
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.style.flex = '1';
    label.textContent = `譜表 ${i + 1}${p.isNew ? '（追加）' : ''}`;
    const sel = document.createElement('select');
    [['treble', 'ト音記号'], ['bass', 'ヘ音記号'], ['alto', 'ハ音記号（アルト）']].forEach(([v, t]) => sel.add(new Option(t, v)));
    sel.value = p.clef;
    sel.addEventListener('change', () => (p.clef = sel.value as Clef));
    const inst = document.createElement('select');
    inst.title = '音色';
    [['piano', 'ピアノ'], ['synth', '電子音']].forEach(([v, t]) => inst.add(new Option(t, v)));
    inst.value = p.instrument;
    inst.addEventListener('change', () => (p.instrument = inst.value as Instrument));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pb danger';
    del.textContent = '削除';
    del.disabled = pendingClefs.filter((q) => !q.remove).length <= 1;
    del.addEventListener('click', () => { p.remove = true; renderPartList(); });
    li.append(label, sel, inst, del);
    ul.appendChild(li);
  });
}

function openSettings() {
  const s = editor.score;
  $<HTMLInputElement>('#set-title').value = s.title;
  $<HTMLInputElement>('#set-composer').value = s.composer;
  $<HTMLInputElement>('#set-tempo').value = String(s.tempo);
  $<HTMLInputElement>('#set-tuning').value = String(s.tuning ?? 440);
  beatsSel.value = String(s.timeSignature.beats);
  $<HTMLSelectElement>('#set-beattype').value = String(s.timeSignature.beatType);
  keySel.value = String(s.keyFifths);
  perSystemSel.value = String(s.layout?.measuresPerSystem ?? 0);
  pendingClefs = s.parts.map((p) => ({ clef: p.clef, instrument: p.instrument, remove: false, isNew: false }));
  renderPartList();
  dlgSet.showModal();
}
on('#btn-settings', openSettings);
on('#btn-add-treble', () => { pendingClefs.push({ clef: 'treble', instrument: 'piano', remove: false, isNew: true }); renderPartList(); });
on('#btn-add-bass', () => { pendingClefs.push({ clef: 'bass', instrument: 'piano', remove: false, isNew: true }); renderPartList(); });

dlgSet.addEventListener('close', () => {
  if (dlgSet.returnValue !== 'ok') return;
  const s = editor.score;
  const title = $<HTMLInputElement>('#set-title').value.trim() || '無題の楽譜';
  const composer = $<HTMLInputElement>('#set-composer').value.trim();
  const tempo = Math.min(300, Math.max(20, Number($<HTMLInputElement>('#set-tempo').value) || 100));
  const tuningRaw = Number($<HTMLInputElement>('#set-tuning').value);
  const tuning = Math.round(Math.min(480, Math.max(400, tuningRaw || 440)) * 10) / 10;
  if (title !== s.title || composer !== s.composer || tempo !== s.tempo || tuning !== (s.tuning ?? 440)) {
    editor.updateMeta({ title, composer, tempo, tuning });
  }
  editor.setMeasuresPerSystem(Number(perSystemSel.value) || null);
  const fifths = Number(keySel.value);
  if (fifths !== s.keyFifths) editor.setKeySignature(fifths);
  const beats = Number(beatsSel.value);
  const beatType = Number($<HTMLSelectElement>('#set-beattype').value);
  if (beats !== s.timeSignature.beats || beatType !== s.timeSignature.beatType) {
    if (s.parts.some((p) => p.measures.some((m) => m.events.some((e) => e.kind === 'note'))) &&
      !confirm('拍子を変えると、音符が新しい小節の長さに並べ直されます。よろしいですか？')) {
      // 拍子だけ取りやめ
    } else editor.setTimeSignature({ beats, beatType });
  }
  // 譜表：後ろから削除してから、記号の変更と追加
  for (let i = pendingClefs.length - 1; i >= 0; i--) {
    const p = pendingClefs[i];
    if (p.remove && !p.isNew) editor.removePart(i);
  }
  const kept = pendingClefs.filter((p) => !p.remove);
  kept.forEach((p, i) => {
    if (!p.isNew && editor.score.parts[i] && editor.score.parts[i].clef !== p.clef) editor.setPartClef(i, p.clef);
    if (p.isNew) editor.addPart(p.clef);
    if (editor.score.parts[i] && editor.score.parts[i].instrument !== p.instrument) editor.setPartInstrument(i, p.instrument);
  });
});

// ---------- 音（入力時の確認音） ----------

let soundOn = safeGet('score-editor:sound') !== '0';
function updateSoundButton() {
  const b = $('#btn-sound');
  setIcon(b, soundOn ? 'soundOn' : 'soundOff');
  b.title = soundOn ? '確認音：オン（タップで消す）' : '確認音：オフ（タップで鳴らす）';
}
on('#btn-sound', () => { soundOn = !soundOn; safeSet('score-editor:sound', soundOn ? '1' : '0'); updateSoundButton(); });
updateSoundButton();

const currentInstrument = () => editor.score.parts[editor.cursor.partIndex]?.instrument ?? 'piano';

/** 入力した音符を短く鳴らす。pos を渡すと、和音のうちその高さの音だけ鳴らす */
function previewSelected(pos?: number) {
  if (!soundOn || player.playing) return;
  const ev = editor.selected;
  if (!ev || ev.kind !== 'note') return;
  const ps = pos === undefined ? ev.pitches : ev.pitches.filter((p) => p.octave * 7 + 'CDEFGAB'.indexOf(p.step) === pos);
  for (const p of ps.length ? ps : ev.pitches) playNote(currentInstrument(), toMidi(p), undefined, 0.45);
}

// iPadで音が出るよう、最初に触れたときに音の準備をする
document.addEventListener('pointerdown', unlock, { capture: true, once: true });
document.addEventListener('keydown', unlock, { capture: true, once: true });

// ---------- 画面の鍵盤 ----------

const panel = $('#input-panel');
const panelShown = () => !panel.hidden;
const held = new Map<number, Voice>();
const keyboard = new PianoKeyboard($('#keyboard'), {
  onPress(midi, alsoHeld) {
    if (editor.mode === 'select') setMode('input');
    // 他の鍵を押さえたまま押した鍵は、直前に入れた音に和音として重ねる
    editor.inputMidi(midi, alsoHeld);
    if (soundOn && !player.playing) {
      held.get(midi)?.stop();
      const v = playNote(currentInstrument(), midi);
      if (v) held.set(midi, v);
    }
  },
  onRelease(midi) {
    held.get(midi)?.stop();
    held.delete(midi);
  },
}, Number(safeGet('score-editor:kb-octave')) || 3);

function updateRange() {
  const range = keyboard.rangeLabel();
  $('#kb-oct-down').title = `1オクターブ下へ（いま ${range}）`;
  $('#kb-oct-up').title = `1オクターブ上へ（いま ${range}）`;
  safeSet('score-editor:kb-octave', String(keyboard.startOctave));
}
function setPanel(show: boolean) {
  panel.hidden = !show;
  $('#btn-keyboard').classList.toggle('on', show);
  safeSet('score-editor:keyboard', show ? '1' : '0');
  if (show) { keyboard.layout(); updateRange(); }
  requestRender();
  // 鍵盤で隠れた入力位置を見えるようにする
  requestAnimationFrame(() => requestAnimationFrame(() => focusInputPosition(true)));
}
on('#btn-keyboard', () => setPanel(panel.hidden));
on('#kb-oct-down', () => { keyboard.shiftOctave(-1); updateRange(); });
on('#kb-oct-up', () => { keyboard.shiftOctave(1); updateRange(); });

// ---------- 再生 ----------

const player = new Player();
const playheadLayer = document.createElement('div');
playheadLayer.className = 'playhead-layer';
/** パートごとの、いま鳴っている音符の位置 */
let playMarks: (ScheduledMark | null)[] = [];

function drawPlayhead() {
  playheadLayer.innerHTML = '';
  for (const m of playMarks) {
    if (!m) continue;
    const h = hits.find((x) => x.partIndex === m.partIndex && x.measureIndex === m.measureIndex);
    const e = h?.events[m.eventIndex];
    if (!h || !e) continue;
    const d = document.createElement('div');
    d.className = 'playhead';
    d.style.left = (e.x - 8) * zoom + 'px';
    d.style.top = (h.topLineY - 24) * zoom + 'px';
    d.style.width = 30 * zoom + 'px';
    d.style.height = (h.lineSpacing * 4 + 48) * zoom + 'px';
    playheadLayer.appendChild(d);
  }
  const first = playheadLayer.firstElementChild as HTMLElement | null;
  if (first) {
    // 見えていなければスクロールして追いかける
    const r = first.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    if (r.top < w.top || r.bottom > w.bottom) wrap.scrollBy({ top: r.top - w.top - 60, behavior: 'smooth' });
  }
}

function litKeys() {
  const set = new Set<number>();
  for (const m of playMarks) {
    const ev = m && editor.score.parts[m.partIndex]?.measures[m.measureIndex]?.events[m.eventIndex];
    if (ev && ev.kind === 'note') for (const p of ev.pitches) set.add(toMidi(p));
  }
  keyboard.highlight(set);
}

function updatePlayButton() {
  const b = $('#btn-play');
  setIcon(b, player.playing ? 'stop' : 'play');
  $('#btn-play span').textContent = player.playing ? '停止' : '再生';
  b.classList.toggle('on', player.playing);
}

function stopPlayback() {
  player.stop();
}

function togglePlay(fromMeasure = editor.cursor.measureIndex) {
  if (player.playing) { stopPlayback(); return; }
  for (const v of held.values()) v.stop();
  held.clear();
  playMarks = [];
  const ok = player.play(editor.score, {
    fromMeasure,
    onMark(m) {
      playMarks[m.partIndex] = m;
      drawPlayhead();
      litKeys();
    },
    onEnd() {
      playMarks = [];
      drawPlayhead();
      litKeys();
      updatePlayButton();
    },
  });
  if (!ok) alert('このブラウザでは音を鳴らせません。');
  updatePlayButton();
}

on('#btn-play', () => togglePlay());
on('#btn-rewind', () => {
  const wasPlaying = player.playing;
  stopPlayback();
  editor.select(null);
  editor.setCursor({ partIndex: editor.cursor.partIndex, measureIndex: 0, eventIndex: 0 });
  wrap.scrollTo({ top: 0, behavior: 'smooth' });
  if (wasPlaying) togglePlay(0);
});
// 楽譜を切り替えたら止める
let playingScoreId = editor.score.id;
editor.onChange(() => {
  if (editor.score.id !== playingScoreId) { playingScoreId = editor.score.id; stopPlayback(); }
});

// ---------- テンポ ----------

const dlgTempo = $<HTMLDialogElement>('#dlg-tempo');
const tempoInput = $<HTMLInputElement>('#tempo-value');
let tempoMeasure = 0;
const PRESETS: [string, number][] = [
  ['Largo', 50], ['Adagio', 66], ['Andante', 76], ['Moderato', 100], ['Allegro', 128], ['Vivace', 152], ['Presto', 176],
];
for (const [name, bpm] of PRESETS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pb';
  b.textContent = `${name} ${bpm}`;
  b.addEventListener('click', () => (tempoInput.value = String(bpm)));
  $('#tempo-presets').appendChild(b);
}
document.querySelectorAll<HTMLButtonElement>('[data-tempo-step]').forEach((b) =>
  b.addEventListener('click', () => {
    const v = (Number(tempoInput.value) || 100) + Number(b.dataset.tempoStep);
    tempoInput.value = String(Math.min(300, Math.max(20, v)));
  }));

/** テンポの入力画面。measure 0 は曲の最初のテンポ、それ以外はその小節からのテンポ変更 */
function openTempo(measure: number) {
  tempoMeasure = measure;
  tempoInput.value = String(tempoAt(editor.score, measure));
  $('#tempo-heading').textContent = measure === 0 ? '曲のテンポ' : `${measure + 1}小節目からのテンポ`;
  $('#btn-tempo-remove').hidden = measure === 0 || tempoMarkAt(editor.score, measure) === null;
  dlgTempo.showModal();
}
on('#btn-tempo', () => openTempo(
  (editor.mode === 'select' ? editor.selectedLocation?.measureIndex : undefined) ?? editor.cursor.measureIndex));
on('#btn-tempo-remove', () => { editor.removeTempo(tempoMeasure); dlgTempo.close('removed'); });
dlgTempo.addEventListener('close', () => {
  if (dlgTempo.returnValue !== 'ok') return;
  const v = Number(tempoInput.value);
  if (!v) return;
  // 直前と同じテンポにした途中の変更は不要なので消す
  if (tempoMeasure > 0 && Math.round(v) === tempoAt(editor.score, tempoMeasure - 1)) editor.removeTempo(tempoMeasure);
  else editor.setTempo(tempoMeasure, v);
});

// ---------- 移調 ----------

setupTranspose(editor, $('#btn-transpose'), $<HTMLDialogElement>('#dlg-transpose'));

// ---------- 小節の記号（リピート・番号付きカッコ・途中の調号と拍子・弱起） ----------

const dlgMeasure = $<HTMLDialogElement>('#dlg-measure');
const mkBeats = $<HTMLSelectElement>('#mk-beats');
const mkBeatType = $<HTMLSelectElement>('#mk-beattype');
const mkKey = $<HTMLSelectElement>('#mk-key');
const mkPickup = $<HTMLSelectElement>('#mk-pickup');
const mkRepeatEnd = $<HTMLInputElement>('#mk-repeat-end');
[2, 3, 4, 5, 6, 7, 9, 12].forEach((n) => mkBeats.add(new Option(String(n), String(n))));
for (const o of Array.from(keySel.options)) mkKey.add(new Option(o.text, o.value));
let marksMeasure = 0;
const updateTimesVisible = () => { $('#mk-times-wrap').hidden = !mkRepeatEnd.checked; };
mkRepeatEnd.addEventListener('change', updateTimesVisible);

/** 弱起の長さの候補（8分音符きざみ、1小節より短いもの） */
function fillPickupOptions() {
  const full = measureCapacity(timeSigAt(editor.score, 0));
  while (mkPickup.options.length > 1) mkPickup.remove(1);
  const names: Record<number, string> = { 240: '8分音符1つ', 480: '4分音符1つ', 720: '付点4分', 960: '2分音符', 1440: '付点2分' };
  for (let t = 240; t < full; t += 240) {
    const beats = t / 480;
    mkPickup.add(new Option(`${names[t] ?? `${beats}拍分`}（${beats}拍）`, String(t)));
  }
}

function openMeasureMarks(measure: number) {
  marksMeasure = measure;
  const s = editor.score;
  const a = measureAttrsAt(s, measure);
  $('#measure-heading').textContent = measure === 0 && s.pickup ? '弱起の小節の記号' : `${measure + (s.pickup ? 0 : 1)}小節目の記号`;
  $<HTMLInputElement>('#mk-repeat-start').checked = !!a?.repeatStart;
  mkRepeatEnd.checked = !!a?.repeatEnd;
  $<HTMLSelectElement>('#mk-times').value = String(a?.repeatTimes ?? 2);
  updateTimesVisible();
  $<HTMLSelectElement>('#mk-volta').value = a?.volta?.join(',') ?? '';
  $<HTMLInputElement>('#mk-system-break').checked = !!a?.systemBreak;
  $<HTMLInputElement>('#mk-page-break').checked = !!a?.pageBreak;
  const tc = measure === 0 ? null : timeSigChangeAt(s, measure);
  const ts = timeSigAt(s, measure);
  // 1小節目は曲全体の設定なので「変えない」は出さず、今の値を出す
  mkBeats.options[0].hidden = measure === 0;
  mkKey.options[0].hidden = measure === 0;
  mkBeats.value = measure === 0 ? String(ts.beats) : tc ? String(tc.beats) : '';
  mkBeatType.value = String(ts.beatType);
  const kc = measure === 0 ? keyAt(s, 0) : keyChangeAt(s, measure);
  mkKey.value = kc === null ? '' : String(kc);
  $('#mk-pickup-wrap').hidden = measure !== 0;
  fillPickupOptions();
  mkPickup.value = String(s.pickup ?? 0);
  dlgMeasure.showModal();
}

dlgMeasure.addEventListener('close', () => {
  if (dlgMeasure.returnValue !== 'ok') return;
  const s = editor.score;
  const mi = marksMeasure;
  const a = measureAttrsAt(s, mi);
  const repeatStart = $<HTMLInputElement>('#mk-repeat-start').checked;
  const repeatEnd = mkRepeatEnd.checked;
  const times = Number($<HTMLSelectElement>('#mk-times').value) || 2;
  const voltaStr = $<HTMLSelectElement>('#mk-volta').value;
  const volta = voltaStr ? voltaStr.split(',').map(Number) : null;
  if (repeatStart !== !!a?.repeatStart || repeatEnd !== !!a?.repeatEnd || (a?.repeatTimes ?? 2) !== times
    || (a?.volta?.join(',') ?? '') !== voltaStr) {
    editor.setRepeat(mi, { repeatStart, repeatEnd, repeatTimes: times, volta });
  }
  // 改行・改ページ
  const sysBreak = $<HTMLInputElement>('#mk-system-break').checked;
  const pageBreak = $<HTMLInputElement>('#mk-page-break').checked;
  if (sysBreak !== !!a?.systemBreak || pageBreak !== !!a?.pageBreak) editor.setBreak(mi, { system: sysBreak, page: pageBreak });
  // 調号
  const wantKey = mkKey.value === '' ? null : Number(mkKey.value);
  if (mi === 0 ? wantKey !== null && wantKey !== s.keyFifths : wantKey !== keyChangeAt(s, mi)) editor.setKeyAt(mi, wantKey);
  // 弱起（拍子より先に。拍子を変えると候補が変わるため）
  if (mi === 0 && Number(mkPickup.value) !== (editor.score.pickup ?? 0)) editor.setPickup(Number(mkPickup.value));
  // 拍子
  const cur = timeSigAt(editor.score, mi);
  if (mkBeats.value === '') {
    if (mi > 0 && timeSigChangeAt(editor.score, mi)) editor.setTimeSignatureAt(mi, null);
  } else {
    const ts = { beats: Number(mkBeats.value), beatType: Number(mkBeatType.value) };
    if (ts.beats !== cur.beats || ts.beatType !== cur.beatType) {
      if (editor.score.parts.some((p) => p.measures.slice(mi).some((m) => m.events.some((e) => e.kind === 'note')))
        && !confirm('拍子を変えると、この小節から後ろの音符が新しい小節の長さに並べ直されます。よろしいですか？')) return;
      editor.setTimeSignatureAt(mi, ts);
    }
  }
});

// ---------- チューニング ----------

setTuning(editor.score.tuning ?? 440);
editor.onChange(() => setTuning(editor.score.tuning ?? 440));

// ---------- 入力位置へのスクロール ----------

let lastFocusKey = '';
/** カーソル（選択モードでは選択中の音符）が見えていなければ、見える位置までスクロールする */
function focusInputPosition(force = false) {
  const loc = editor.mode === 'input' ? editor.cursor : editor.selectedLocation;
  if (!loc) return;
  const key = `${editor.mode}:${loc.partIndex}:${loc.measureIndex}:${loc.eventIndex}`;
  if (!force && key === lastFocusKey) return;
  lastFocusKey = key;
  if (player.playing) return;
  const h = hits.find((x) => x.partIndex === loc.partIndex && x.measureIndex === loc.measureIndex);
  if (!h) return;
  const e = h.events[Math.min(loc.eventIndex, h.events.length - 1)];
  const s = scoreEl.getBoundingClientRect();
  const w = wrap.getBoundingClientRect();
  const top = s.top + (h.topLineY - 50) * zoom;
  const bottom = s.top + (h.topLineY + h.lineSpacing * 4 + 50) * zoom;
  const left = s.left + ((e?.x ?? h.x0) - 40) * zoom;
  const right = s.left + ((e?.x ?? h.x1) + 60) * zoom;
  let dy = 0;
  let dx = 0;
  if (top < w.top) dy = top - w.top - 20;
  else if (bottom > w.bottom) dy = bottom - w.bottom + 20;
  if (left < w.left) dx = left - w.left;
  else if (right > w.right) dx = right - w.right;
  if (dx || dy) wrap.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
}

// ---------- ダブルタップでの拡大を止める ----------

// CSS の touch-action が効かない古いiPadOS向け。すばやい2回目のタップは拡大の代わりにクリックにする。
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  const t = e.target as HTMLElement;
  if (now - lastTouchEnd < 350 && !t.closest('input, select, textarea')) {
    e.preventDefault();
    if (t.closest('button, label')) (t.closest('button, label') as HTMLElement).click();
  }
  lastTouchEnd = now;
}, { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault());

// ---------- 起動 ----------

window.addEventListener('resize', () => {
  if (panelShown()) { keyboard.layout(); updateRange(); }
  requestRender();
});
// 初めての人には鍵盤を出しておく
setPanel(safeGet('score-editor:keyboard') !== '0');
render();
try {
  saveScore(editor.score);
  statusEl.textContent = '保存済み';
} catch {
  statusEl.textContent = '保存できませんでした';
}
// 保存を消さないようブラウザに頼み、しばらくバックアップしていなければ声をかける
requestPersist().then((st) => { persistState = st; });
setTimeout(maybeRemindBackup, 4000);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* オフライン対応なしで続ける */ });
}

// 開発中の確認用
(window as unknown as { editor: Editor }).editor = editor;
