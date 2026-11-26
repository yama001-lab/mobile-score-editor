import './style.css';
import { Editor } from './editor/editor';
import { DURATION_LABELS, DurationType } from './model/duration';
import { keyLabelJa, Step } from './model/pitch';
import { Clef, Score, createScore } from './model/score';
import { MeasureHit, diatonicAtY, renderScore } from './render/render';
import { deleteScore, lastScoreId, listScores, loadScore, migrate, saveScore } from './storage/local';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

function initialScore(): Score {
  const id = lastScoreId();
  const s = id ? loadScore(id) : null;
  return s ?? createScore();
}

const editor = new Editor(initialScore());
const scoreEl = $('#score');
const wrap = $('#score-wrap');
let hits: MeasureHit[] = [];
let zoom = Number(safeGet('score-editor:zoom')) || 1;

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
    cursor: editor.mode === 'input' ? editor.cursor : null,
  });
  hits = res.hits;
  updatePalette();
}

const durationsEl = $('#durations');
(['w', 'h', 'q', '8', '16'] as DurationType[]).forEach((d) => {
  const b = document.createElement('button');
  b.className = 'pb';
  b.dataset.duration = d;
  b.textContent = DURATION_LABELS[d];
  b.title = `${DURATION_LABELS[d]}音符 (${({ w: 7, h: 6, q: 5, '8': 4, '16': 3 } as Record<string, number>)[d]})`;
  b.addEventListener('click', () => editor.setInputDuration(d));
  durationsEl.appendChild(b);
});

function updatePalette() {
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
    b.classList.toggle('on', b.dataset.mode === editor.mode));
  document.querySelectorAll<HTMLButtonElement>('[data-duration]').forEach((b) =>
    b.classList.toggle('on', b.dataset.duration === editor.inputDuration));
  $('#btn-dot').classList.toggle('on', editor.inputDots > 0);
  $('#btn-chord').classList.toggle('on', editor.chordMode);
  const sel = editor.selected;
  const isNote = sel?.kind === 'note';
  $('#btn-tie').classList.toggle('on', !!(isNote && sel.tie));
  for (const id of ['#btn-up', '#btn-down', '#btn-tie']) ($(id) as HTMLButtonElement).disabled = !isNote;
  document.querySelectorAll<HTMLButtonElement>('[data-alter]').forEach((b) => (b.disabled = !isNote));
  for (const id of ['#btn-left', '#btn-right', '#btn-delete']) ($(id) as HTMLButtonElement).disabled = !sel;
  ($('#btn-undo') as HTMLButtonElement).disabled = !editor.canUndo;
  ($('#btn-redo') as HTMLButtonElement).disabled = !editor.canRedo;
  scoreEl.classList.toggle('input-mode', editor.mode === 'input');
  const title = $<HTMLInputElement>('#title');
  if (document.activeElement !== title) title.value = editor.score.title;
  $('#hint').textContent = editor.mode === 'input'
    ? '入力モード：五線をタップすると、その位置に音符が入ります。音の長さは上のボタンで選びます。'
    : '選択モード：音符をタップして選び、上下にドラッグすると音の高さが変わります。';
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
  if (ev.button > 0) return;
  const { x, y } = localPoint(ev);
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

function endPointer(ev: PointerEvent, cancelled: boolean) {
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
    if (!(editor.chordMode || ev.shiftKey) || editor.selected?.kind !== 'note') {
      editor.setCursor({ partIndex: h.partIndex, measureIndex: h.measureIndex, eventIndex: idx });
    }
    if (ev.shiftKey && !editor.chordMode) {
      editor.toggleChordMode();
      editor.inputDiatonic(pos);
      editor.toggleChordMode();
    } else editor.inputDiatonic(pos);
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
  b.addEventListener('click', () => editor.setMode(b.dataset.mode as 'select' | 'input')));
document.querySelectorAll<HTMLButtonElement>('[data-alter]').forEach((b) =>
  b.addEventListener('click', () => editor.setSelectedAccidental(Number(b.dataset.alter))));
on('#btn-dot', () => editor.toggleDot());
on('#btn-rest', () => editor.inputRest());
on('#btn-tie', () => editor.toggleTie());
on('#btn-chord', () => editor.toggleChordMode());
on('#btn-up', () => editor.transposeSelected(1));
on('#btn-down', () => editor.transposeSelected(-1));
on('#btn-left', () => editor.shiftSelected(-1));
on('#btn-right', () => editor.shiftSelected(1));
on('#btn-delete', () => editor.deleteSelected());
on('#btn-undo', () => editor.undo());
on('#btn-redo', () => editor.redo());
on('#btn-add-measure', () => editor.addMeasure());
on('#btn-remove-measure', () => editor.removeMeasure());
on('#btn-zoom-in', () => setZoom(zoom * 1.15));
on('#btn-zoom-out', () => setZoom(zoom / 1.15));
on('#btn-pdf', async () => {
  const b = $<HTMLButtonElement>('#btn-pdf');
  b.disabled = true;
  b.textContent = '作成中…';
  try {
    const { exportPdf } = await import('./export/pdf');
    await exportPdf(editor.score);
  } catch (e) {
    alert('PDFを作れませんでした: ' + (e as Error).message);
  } finally {
    b.disabled = false;
    b.textContent = 'PDF';
  }
});

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
  if (/^[a-gA-G]$/.test(k)) {
    if (editor.mode !== 'input') editor.setMode('input');
    if (e.shiftKey && editor.selected?.kind === 'note') {
      editor.toggleChordMode(); editor.inputStep(k.toUpperCase() as Step); editor.toggleChordMode();
    } else editor.inputStep(k.toUpperCase() as Step);
    return;
  }
  if (DURATION_KEYS[k]) { editor.setInputDuration(DURATION_KEYS[k]); return; }
  switch (k) {
    case 'n': case 'N': editor.setMode(editor.mode === 'input' ? 'select' : 'input'); break;
    case 'Escape': editor.setMode('select'); break;
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
  editor.setMode('input');
  dlgList.close();
}
on('#btn-new-single', () => newScore(false));
on('#btn-new-grand', () => newScore(true));
on('#btn-export-json', () => {
  const blob = new Blob([JSON.stringify(editor.score, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (editor.score.title || 'score') + '.json';
  a.click();
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
let pendingClefs: { clef: Clef; remove: boolean; isNew: boolean }[] = [];

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
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pb danger';
    del.textContent = '削除';
    del.disabled = pendingClefs.filter((q) => !q.remove).length <= 1;
    del.addEventListener('click', () => { p.remove = true; renderPartList(); });
    li.append(label, sel, del);
    ul.appendChild(li);
  });
}

on('#btn-settings', () => {
  const s = editor.score;
  $<HTMLInputElement>('#set-title').value = s.title;
  $<HTMLInputElement>('#set-composer').value = s.composer;
  $<HTMLInputElement>('#set-tempo').value = String(s.tempo);
  beatsSel.value = String(s.timeSignature.beats);
  $<HTMLSelectElement>('#set-beattype').value = String(s.timeSignature.beatType);
  keySel.value = String(s.keyFifths);
  pendingClefs = s.parts.map((p) => ({ clef: p.clef, remove: false, isNew: false }));
  renderPartList();
  dlgSet.showModal();
});
on('#btn-add-treble', () => { pendingClefs.push({ clef: 'treble', remove: false, isNew: true }); renderPartList(); });
on('#btn-add-bass', () => { pendingClefs.push({ clef: 'bass', remove: false, isNew: true }); renderPartList(); });

dlgSet.addEventListener('close', () => {
  if (dlgSet.returnValue !== 'ok') return;
  const s = editor.score;
  const title = $<HTMLInputElement>('#set-title').value.trim() || '無題の楽譜';
  const composer = $<HTMLInputElement>('#set-composer').value.trim();
  const tempo = Math.min(300, Math.max(20, Number($<HTMLInputElement>('#set-tempo').value) || 100));
  if (title !== s.title || composer !== s.composer || tempo !== s.tempo) editor.updateMeta({ title, composer, tempo });
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
  });
});

// ---------- 起動 ----------

window.addEventListener('resize', requestRender);
render();
saveScore(editor.score);
statusEl.textContent = '保存済み';

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* オフライン対応なしで続ける */ });
}

// 開発中の確認用
(window as unknown as { editor: Editor }).editor = editor;
