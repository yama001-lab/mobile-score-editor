/**
 * 記号の道具：スラー・強弱記号（とクレッシェンド／ディミヌエンド）・奏法（アーティキュレーション）。
 * #palette にグループを1つ足し、強弱と奏法はポップアップのメニューで選ぶ。
 * main.ts からは setupMarksPalette(editor) を呼ぶだけ。
 */
import './marks.css';
import { Editor } from '../editor/editor';
import { ARTICULATIONS, ARTICULATION_LABELS, DYNAMICS, spannersAt } from '../model/marks';
import { Articulation, SpannerKind } from '../model/score';

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const dot = (cx: number, cy: number) => `<ellipse cx="${cx}" cy="${cy}" rx="2.6" ry="1.9" transform="rotate(-20 ${cx} ${cy})" fill="currentColor"/>`;

export const MARK_ICONS = {
  slur: svg(dot(5, 17) + dot(19, 17) + '<path d="M4 13q8-9 16 0"/>'),
  articulation: svg(dot(12, 18) + '<path d="M7 6l10 3.5L7 13"/>'),
  staccato: svg('<circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/>'),
  accent: svg('<path d="M5 7l14 5-14 5"/>'),
  tenuto: svg('<path d="M5 12h14" stroke-width="2.4"/>'),
  marcato: svg('<path d="M6 18L12 5l6 13" stroke-width="2.4"/>'),
  fermata: svg('<path d="M4 17a8 8 0 0 1 16 0"/><circle cx="12" cy="15" r="1.8" fill="currentColor" stroke="none"/>'),
  cresc: svg('<path d="M3 12l18-6M3 12l18 6"/>'),
  dim: svg('<path d="M21 12L3 6M21 12L3 18"/>'),
} as const;

interface Ui {
  slur: HTMLButtonElement;
  dyn: HTMLButtonElement;
  art: HTMLButtonElement;
  dynMenu: HTMLElement;
  artMenu: HTMLElement;
}

function tool(id: string, icon: string, label: string, title: string) {
  const b = document.createElement('button');
  b.id = id;
  b.className = 'tool';
  b.title = title;
  b.innerHTML = `${icon}<span>${label}</span>`;
  return b;
}

function placeMenu(menu: HTMLElement, anchor: HTMLElement) {
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(r.left + r.width / 2 - m.width / 2, window.innerWidth - m.width - 8)) + 'px';
  menu.style.top = Math.max(8, r.top - m.height - 8) + 'px';
}

export function setupMarksPalette(editor: Editor, opts: { onMessage?: (text: string) => void } = {}): void {
  const palette = document.getElementById('palette');
  if (!palette) return;
  const group = document.createElement('div');
  group.className = 'group';
  group.id = 'marks-tools';
  group.setAttribute('aria-label', '記号');
  const ui: Ui = {
    slur: tool('btn-slur', MARK_ICONS.slur, 'スラー', 'スラー (S)：選んだ音符から次の音符へ。続けて押すと伸びます。入力モードでは直前の音符からつなぎます'),
    dyn: tool('btn-dyn', '<b class="dyn-glyph">mf</b>', '強弱', '強弱記号とクレッシェンド・ディミヌエンド'),
    art: tool('btn-art', MARK_ICONS.articulation, '奏法', 'スタッカート・アクセント・フェルマータなど'),
    dynMenu: document.createElement('div'),
    artMenu: document.createElement('div'),
  };
  group.append(ui.slur, ui.dyn, ui.art);
  // 臨時記号のすぐ後ろに置く（なければ最後）
  const acc = palette.querySelector('[aria-label="臨時記号"]');
  if (acc?.nextSibling) palette.insertBefore(group, acc.nextSibling);
  else palette.appendChild(group);

  // 強弱メニュー
  const dm = ui.dynMenu;
  dm.className = 'menu marks-menu';
  dm.id = 'dyn-menu';
  dm.setAttribute('role', 'menu');
  dm.hidden = true;
  const grid = document.createElement('div');
  grid.className = 'marks-grid';
  for (const d of DYNAMICS) {
    const b = document.createElement('button');
    b.dataset.dynamic = d;
    b.setAttribute('role', 'menuitemcheckbox');
    b.innerHTML = `<b class="dyn-glyph">${d}</b>`;
    b.title = d;
    b.addEventListener('click', () => { editor.setDynamic(d); close(); });
    grid.appendChild(b);
  }
  dm.appendChild(grid);
  dm.appendChild(document.createElement('hr'));
  const spanBtn = (kind: SpannerKind, label: string) => {
    const b = document.createElement('button');
    b.dataset.spanner = kind;
    b.setAttribute('role', 'menuitemcheckbox');
    b.innerHTML = `${MARK_ICONS[kind as 'cresc' | 'dim']}<span>${label}</span>`;
    b.className = 'with-icon';
    b.addEventListener('click', () => { editor.toggleSpanner(kind); close(); });
    return b;
  };
  dm.appendChild(spanBtn('cresc', 'クレッシェンド（だんだん強く）'));
  dm.appendChild(spanBtn('dim', 'ディミヌエンド（だんだん弱く）'));
  const clear = document.createElement('button');
  clear.className = 'danger';
  clear.id = 'btn-dyn-clear';
  clear.textContent = '強弱記号を消す';
  clear.addEventListener('click', () => { editor.setDynamic(null); close(); });
  dm.appendChild(clear);
  const note = document.createElement('p');
  note.className = 'marks-note';
  note.textContent = 'クレッシェンドなどは選んだ音符から次の音符まで。もう一度選ぶと1音ずつ伸びます';
  dm.appendChild(note);

  // 奏法メニュー
  const am = ui.artMenu;
  am.className = 'menu marks-menu';
  am.id = 'art-menu';
  am.setAttribute('role', 'menu');
  am.hidden = true;
  for (const a of ARTICULATIONS) {
    const b = document.createElement('button');
    b.dataset.articulation = a;
    b.className = 'with-icon';
    b.setAttribute('role', 'menuitemcheckbox');
    b.innerHTML = `${MARK_ICONS[a]}<span>${ARTICULATION_LABELS[a]}</span>`;
    b.addEventListener('click', () => { editor.toggleArticulation(a as Articulation); close(); });
    am.appendChild(b);
  }
  document.body.append(dm, am);

  function close() {
    dm.hidden = true;
    am.hidden = true;
  }
  function needSelection() {
    if (editor.selected) return true;
    opts.onMessage?.('先に音符を選んでください');
    return false;
  }
  ui.slur.addEventListener('click', () => { if (needSelection()) editor.toggleSpanner('slur'); });
  ui.dyn.addEventListener('click', () => {
    if (!dm.hidden) { close(); return; }
    if (!needSelection()) return;
    close();
    update();
    placeMenu(dm, ui.dyn);
  });
  ui.art.addEventListener('click', () => {
    if (!am.hidden) { close(); return; }
    if (!needSelection()) return;
    close();
    update();
    placeMenu(am, ui.art);
  });
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest('#dyn-menu, #art-menu, #btn-dyn, #btn-art')) close();
  }, { capture: true });

  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || document.querySelector('dialog[open]')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 's' || e.key === 'S') { if (editor.selected) editor.toggleSpanner('slur'); }
    if (e.key === 'Escape') close();
  });

  function update() {
    const sel = editor.selected;
    const isNote = sel?.kind === 'note';
    const spans = sel ? spannersAt(editor.score, sel.id) : [];
    ui.slur.disabled = !isNote;
    ui.slur.classList.toggle('on', spans.includes('slur'));
    ui.dyn.disabled = !sel;
    ui.art.disabled = !sel;
    ui.dyn.classList.toggle('on', !!sel?.dynamic || spans.includes('cresc') || spans.includes('dim'));
    ui.art.classList.toggle('on', !!sel?.articulations?.length);
    const dynGlyph = ui.dyn.querySelector('.dyn-glyph');
    if (dynGlyph) dynGlyph.textContent = sel?.dynamic ?? 'mf';
    dm.querySelectorAll<HTMLButtonElement>('[data-dynamic]').forEach((b) =>
      b.classList.toggle('on', b.dataset.dynamic === sel?.dynamic));
    dm.querySelectorAll<HTMLButtonElement>('[data-spanner]').forEach((b) =>
      b.classList.toggle('on', spans.includes(b.dataset.spanner as SpannerKind)));
    (dm.querySelector('#btn-dyn-clear') as HTMLButtonElement).disabled = !sel?.dynamic;
    am.querySelectorAll<HTMLButtonElement>('[data-articulation]').forEach((b) => {
      const a = b.dataset.articulation as Articulation;
      b.classList.toggle('on', !!sel?.articulations?.includes(a));
      b.disabled = sel?.kind === 'rest' && a !== 'fermata';
    });
    if (!sel) close();
  }
  editor.onChange(update);
  update();
}
