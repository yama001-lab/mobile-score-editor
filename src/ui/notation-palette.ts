/**
 * 記号 第2弾の道具：装飾音と、オクターブ記号（8va/8vb）・ペダル。
 * #palette の記号グループ（#marks-tools）の後ろにボタンを足し、ポップアップのメニューで選ぶ。
 * セーニョ・コーダ・D.S. と途中の音部記号は、小節の記号のダイアログ（main.ts の #dlg-measure）で付ける。
 */
import './marks.css';
import { Editor } from '../editor/editor';
import { spannersAt } from '../model/marks';
import { SpannerKind } from '../model/score';

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const NOTATION_ICONS = {
  // 小さな8分音符（斜線付き）と大きな音符
  grace: svg('<ellipse cx="7" cy="16" rx="2.4" ry="1.7" transform="rotate(-20 7 16)" fill="currentColor"/><path d="M9.2 15.4V6l3 2.2M6.5 11.5l5-3.5"/>'
    + '<ellipse cx="17" cy="18" rx="3.2" ry="2.3" transform="rotate(-20 17 18)" fill="currentColor"/><path d="M20 17.2V5"/>'),
  ottava: svg('<text x="2" y="14" font-size="10" font-style="italic" font-weight="700" fill="currentColor" stroke="none" font-family="serif">8va</text><path d="M3 19h3m3 0h3m3 0h3l0-4" />'),
  pedal: svg('<text x="1" y="15" font-size="11" font-style="italic" font-weight="700" fill="currentColor" stroke="none" font-family="serif">Ped</text><path d="M3 20h17v-4"/>'),
} as const;

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

function menuButton(label: string, onClick: () => void, opts: { id?: string; icon?: string; danger?: boolean } = {}) {
  const b = document.createElement('button');
  if (opts.id) b.id = opts.id;
  b.setAttribute('role', 'menuitem');
  if (opts.icon) {
    b.className = 'with-icon';
    b.innerHTML = `${opts.icon}<span>${label}</span>`;
  } else b.textContent = label;
  if (opts.danger) b.classList.add('danger');
  b.addEventListener('click', onClick);
  return b;
}

export function setupNotationPalette(editor: Editor, opts: { onMessage?: (text: string) => void } = {}): void {
  const palette = document.getElementById('palette');
  if (!palette) return;
  const graceBtn = tool('btn-grace', NOTATION_ICONS.grace, '装飾音', '装飾音（前打音）：選んだ音符の前に付けます。入力モードでは直前に入れた音符の前');
  const lineBtn = tool('btn-lines', NOTATION_ICONS.ottava, '8va・ペダル', 'オクターブ記号（8va・8vb）とペダル：選んだ音符から次の音符へ。続けて押すと伸びます');
  const marks = document.getElementById('marks-tools');
  if (marks) marks.append(graceBtn, lineBtn);
  else {
    const group = document.createElement('div');
    group.className = 'group';
    group.setAttribute('aria-label', '装飾音など');
    group.append(graceBtn, lineBtn);
    palette.appendChild(group);
  }

  // 装飾音のメニュー
  const gm = document.createElement('div');
  gm.className = 'menu marks-menu';
  gm.id = 'grace-menu';
  gm.setAttribute('role', 'menu');
  gm.hidden = true;
  const keep = (fn: () => void) => () => { fn(); update(); };
  gm.append(
    menuButton('短前打音（斜線あり）を足す', () => { editor.addGrace(true); close(); }, { id: 'btn-grace-add-slash' }),
    menuButton('長前打音を足す', () => { editor.addGrace(false); close(); }, { id: 'btn-grace-add' }),
    document.createElement('hr'),
  );
  const row = document.createElement('div');
  row.className = 'marks-grid';
  const small = (label: string, title: string, fn: () => void) => {
    const b = menuButton(label, keep(fn));
    b.title = title;
    b.dataset.graceEdit = '1';
    return b;
  };
  row.append(
    small('▲', '装飾音を1つ上へ', () => editor.shiftGrace(1)),
    small('▼', '装飾音を1つ下へ', () => editor.shiftGrace(-1)),
    small('♯', '装飾音にシャープ', () => editor.setGraceAccidental(1)),
    small('♭', '装飾音にフラット', () => editor.setGraceAccidental(-1)),
  );
  gm.append(row);
  const rmLast = menuButton('いちばん後ろの装飾音を消す', keep(() => editor.removeGraces(true)), { id: 'btn-grace-remove-last' });
  const rmAll = menuButton('装飾音をすべて消す', () => { editor.removeGraces(); close(); }, { id: 'btn-grace-remove', danger: true });
  rmLast.dataset.graceEdit = '1';
  rmAll.dataset.graceEdit = '1';
  const note = document.createElement('p');
  note.className = 'marks-note';
  note.textContent = '▲▼・♯♭は本音符のすぐ前の装飾音を変えます。続けて足すと本音符のすぐ前に並びます';
  gm.append(rmLast, rmAll, note);

  // 8va・ペダルのメニュー
  const lm = document.createElement('div');
  lm.className = 'menu marks-menu';
  lm.id = 'lines-menu';
  lm.setAttribute('role', 'menu');
  lm.hidden = true;
  const spanBtn = (kind: SpannerKind, label: string, icon: string) => {
    const b = menuButton(label, () => { editor.toggleSpanner(kind); close(); }, { icon });
    b.dataset.spanner = kind;
    b.setAttribute('role', 'menuitemcheckbox');
    return b;
  };
  lm.append(
    spanBtn('8va', '8va（1オクターブ上で弾く）', NOTATION_ICONS.ottava),
    spanBtn('8vb', '8vb（1オクターブ下で弾く）', NOTATION_ICONS.ottava.replace('8va', '8vb')),
    spanBtn('pedal', 'ペダル（踏んで、終わりで上げる）', NOTATION_ICONS.pedal),
  );
  const lnote = document.createElement('p');
  lnote.className = 'marks-note';
  lnote.textContent = '選んだ音符から次の音符まで。もう一度選ぶと1音ずつ伸びます。始まりの音符で選ぶと消えます';
  lm.append(lnote);
  document.body.append(gm, lm);

  function close() {
    gm.hidden = true;
    lm.hidden = true;
  }
  function needNote() {
    if (editor.selected?.kind === 'note') return true;
    opts.onMessage?.('先に音符を選んでください');
    return false;
  }
  graceBtn.addEventListener('click', () => {
    if (!gm.hidden) { close(); return; }
    if (!needNote()) return;
    close();
    update();
    placeMenu(gm, graceBtn);
  });
  lineBtn.addEventListener('click', () => {
    if (!lm.hidden) { close(); return; }
    if (!editor.selected) { opts.onMessage?.('先に音符を選んでください'); return; }
    close();
    update();
    placeMenu(lm, lineBtn);
  });
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest('#grace-menu, #lines-menu, #btn-grace, #btn-lines')) close();
  }, { capture: true });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  function update() {
    const sel = editor.selected;
    const isNote = sel?.kind === 'note';
    const hasGrace = isNote && !!sel.graces?.length;
    const spans = sel ? spannersAt(editor.score, sel.id) : [];
    graceBtn.disabled = !isNote;
    graceBtn.classList.toggle('on', hasGrace);
    lineBtn.disabled = !sel;
    lineBtn.classList.toggle('on', spans.some((k) => k === '8va' || k === '8vb' || k === 'pedal'));
    gm.querySelectorAll<HTMLButtonElement>('[data-grace-edit]').forEach((b) => { b.disabled = !hasGrace; });
    lm.querySelectorAll<HTMLButtonElement>('[data-spanner]').forEach((b) => {
      const kind = b.dataset.spanner as SpannerKind;
      b.classList.toggle('on', spans.includes(kind));
      // オクターブ記号は音符から
      b.disabled = kind !== 'pedal' && !isNote;
    });
    if (!sel) close();
  }
  editor.onChange(update);
  update();
}
