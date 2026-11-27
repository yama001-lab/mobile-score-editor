import './style.css';
import { Editor, Mode } from './editor/editor';
import { DURATION_LABELS, DurationType } from './model/duration';
import { keyLabelJa, Step, toMidi } from './model/pitch';
import { Clef, Instrument, Score, createScore, tempoAt, tempoMarkAt } from './model/score';
import { Player } from './audio/player';
import { ScheduledMark } from './audio/schedule';
import { playNote, setTuning, unlock, Voice } from './audio/synth';
import { PianoKeyboard } from './input/keyboard';
import { MeasureHit, TempoHit, diatonicAtY, renderScore } from './render/render';
import { applyIcons, ICONS, setIcon } from './ui/icons';
import { PenLayer } from './handwriting/pen';
import { applyRecognized, staffOf } from './handwriting/apply';
import { Stroke, boxOf, clusterStrokes, recognizeCluster } from './handwriting/recognize';
import { deleteScore, lastScoreId, listScores, loadScore, migrate, saveScore } from './storage/local';

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
let zoom = Number(safeGet('score-editor:zoom')) || 1;

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
  const res = renderScore(scoreEl, editor.score, {
    width,
    scale: zoom,
    selectedId: editor.selectedId,
    selectedPitchIndex: editor.selectedPitchIndex,
    cursor: editor.mode !== 'select' ? editor.cursor : null,
  });
  hits = res.hits;
  tempoHits = res.tempoHits;
  scoreEl.appendChild(playheadLayer);
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
  $('#btn-dot').classList.toggle('on', editor.inputDots > 0);
  $('#btn-chord').classList.toggle('on', editor.chordMode);
  // 入力モードのタイは「直前の音とタイでつないで足す」なので、選択がなくても押せる
  $('#btn-tie').classList.toggle('on', !!(isNote && sel.tie));
  ($('#btn-tie') as HTMLButtonElement).disabled = !isNote && editor.mode !== 'input';
  ($('#btn-back') as HTMLButtonElement).disabled = !editor.canUndo;
  for (const id of ['#btn-up', '#btn-down']) ($(id) as HTMLButtonElement).disabled = !isNote;
  document.querySelectorAll<HTMLButtonElement>('[data-alter]').forEach((b) => (b.disabled = !isNote));
  for (const id of ['#btn-left', '#btn-right', '#btn-delete']) ($(id) as HTMLButtonElement).disabled = !sel;
  ($('#btn-undo') as HTMLButtonElement).disabled = !editor.canUndo;
  ($('#btn-redo') as HTMLButtonElement).disabled = !editor.canRedo;
  scoreEl.classList.toggle('input-mode', editor.mode === 'input');
  scoreEl.classList.toggle('pen-mode', editor.mode === 'pen');
  $('#pen-tools').hidden = editor.mode !== 'pen';
  $('#btn-finger').classList.toggle('on', penLayer.fingerDraws);
  const title = $<HTMLInputElement>('#title');
  if (document.activeElement !== title) title.value = editor.score.title;
  const hintKey = `${editor.mode}:${panelShown()}`;
  if (hintKey !== lastHintKey) {
    lastHintKey = hintKey;
    showHint(editor.mode === 'pen'
      ? '手書き：五線に音符を書くと、少し待って音符に変わります。白丸＝全、白丸＋棒＝2分、黒丸＋棒＝4分、旗で8分・16分。こすると消えます。2本指でスクロール'
      : editor.mode === 'input'
      ? (panelShown()
        ? '入力：鍵盤を押すと青い帯の位置に入ります。押さえたまま別の鍵で和音。五線のタップでも入ります'
        : '入力：五線をタップすると、その高さの音符が入ります')
      : '選択：音符をタップして選び、上下にドラッグで高さを変えます');
  }
}

let lastHintKey = '';
let hintTimer = 0;
function showHint(text: string) {
  const h = $('#hint');
  h.textContent = text;
  h.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => h.classList.remove('show'), 3500);
}

let toastTimer = 0;
function toast(text: string, ms = 3500) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  $('#hint').classList.remove('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

// ---------- 保存 ----------

let saveTimer = 0;
const statusEl = $('#save-status');
editor.onChange((reason) => {
  requestRender();
  if (reason === 'score') {
    statusEl.textContent = '保存中…';
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try {
        saveScore(editor.score);
        statusEl.textContent = '保存済み';
      } catch {
        statusEl.textContent = '保存できませんでした';
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

let drag: { pointerId: number; startY: number; moved: boolean; onSelected: boolean; hit: MeasureHit } | null = null;

scoreEl.addEventListener('pointerdown', (ev) => {
  if (ev.button > 0 || editor.mode === 'pen') return;
  const { x, y } = localPoint(ev);
  const th = tempoHits.find((t) => x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h);
  if (th) { tempoTap = { pointerId: ev.pointerId, measure: th.measure }; return; }
  const h = hitAt(x, y);
  if (!h) return;
  const idx = eventIndexAt(h, x);
  const e = h.events[idx];
  const onSelected = !!e && e.id === editor.selectedId && editor.mode === 'select';
  drag = { pointerId: ev.pointerId, startY: y, moved: false, onSelected, hit: h };
  if (onSelected) scoreEl.setPointerCapture(ev.pointerId);
});

scoreEl.addEventListener('pointermove', (ev) => {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const { y } = localPoint(ev);
  if (Math.abs(y - drag.startY) > 4) drag.moved = true;
  if (drag.onSelected && drag.moved) editor.moveSelectedTo(diatonicAtY(drag.hit, y));
});

// ドラッグ中は画面がスクロールしないようにする（iPadのSafari向け）
scoreEl.addEventListener('touchmove', (ev) => { if (drag?.onSelected) ev.preventDefault(); }, { passive: false });

let tempoTap: { pointerId: number; measure: number } | null = null;

function endPointer(ev: PointerEvent, cancelled: boolean) {
  if (tempoTap && tempoTap.pointerId === ev.pointerId) {
    const m = tempoTap.measure;
    tempoTap = null;
    if (!cancelled) openTempo(m);
    return;
  }
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  editor.endGesture();
  if (cancelled || d.moved) return;
  const { x, y } = localPoint(ev);
  const h = hitAt(x, y) ?? d.hit;
  const idx = eventIndexAt(h, x);
  if (editor.mode === 'input') {
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
    const e = h.events[idx];
    if (!e) return;
    let pi = 0;
    if (e.headYs.length > 1) {
      let bd = Infinity;
      e.headYs.forEach((hy, i) => { const dd = Math.abs(hy - y); if (dd < bd) { bd = dd; pi = i; } });
      // VexFlowの getYs() は低い音から順
    }
    editor.select(e.id, pi);
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
on('#btn-dot', () => editor.toggleDot());
on('#btn-rest', () => editor.inputRest());
on('#btn-tie', () => { editor.toggleTie(); previewSelected(); });
on('#btn-chord', () => editor.toggleChordMode());
on('#btn-back', () => editor.undo());
on('#btn-up', () => editor.transposeSelected(1));
on('#btn-down', () => editor.transposeSelected(-1));
on('#btn-left', () => editor.shiftSelected(-1));
on('#btn-right', () => editor.shiftSelected(1));
on('#btn-delete', () => editor.deleteSelected());
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
on('#btn-insert-measure', () => editor.addMeasure(editor.cursor.measureIndex - 1));
on('#btn-remove-measure', () => editor.removeMeasure());
on('#btn-meter', () => openSettings());

// 道具バーが右に続いていることを示すぼかしは、端までスクロールしたら消す
const paletteEl = $('#palette');
function updatePaletteFade() {
  paletteEl.classList.toggle('at-end', paletteEl.scrollLeft + paletteEl.clientWidth >= paletteEl.scrollWidth - 2);
}
paletteEl.addEventListener('scroll', updatePaletteFade, { passive: true });

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
    case 'Escape': setMode('select'); break;
    case '.': editor.toggleDot(); break;
    case '0': editor.inputRest(); break;
    case 't': case 'T': editor.toggleTie(); break;
    case 'ArrowUp': e.preventDefault(); editor.transposeSelected(e.shiftKey ? 7 : 1); break;
    case 'ArrowDown': e.preventDefault(); editor.transposeSelected(e.shiftKey ? -7 : -1); break;
    case 'ArrowLeft': e.preventDefault(); editor.moveSelection(-1); break;
    case 'ArrowRight': e.preventDefault(); editor.moveSelection(1); break;
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
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (editor.score.title || 'score').replace(/[\\/:*?"<>|]/g, '_') + '.musicxml';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
on('#btn-export-json', () => {
  const blob = new Blob([JSON.stringify(editor.score, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (editor.score.title || 'score') + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
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

// ---------- 設定 ----------

const dlgSet = $<HTMLDialogElement>('#dlg-settings');
const beatsSel = $<HTMLSelectElement>('#set-beats');
[2, 3, 4, 5, 6, 7, 9, 12].forEach((n) => beatsSel.add(new Option(String(n), String(n))));
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
  updatePaletteFade();
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
  updatePaletteFade();
});
// 初めての人には鍵盤を出しておく
setPanel(safeGet('score-editor:keyboard') !== '0');
render();
saveScore(editor.score);
statusEl.textContent = '保存済み';

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* オフライン対応なしで続ける */ });
}

// 開発中の確認用
(window as unknown as { editor: Editor }).editor = editor;
