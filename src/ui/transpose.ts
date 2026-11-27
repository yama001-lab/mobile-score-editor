/** 移調の画面（#dlg-transpose）。調か音程を選び、楽譜全体・譜表・選んだ音符を動かす。 */
import { Editor, TransposeScope } from '../editor/editor';
import { keyLabelJa } from '../model/pitch';
import { INTERVALS, Interval, intervalBetweenKeys } from '../model/transpose';

export function setupTranspose(editor: Editor, button: HTMLElement, dlg: HTMLDialogElement) {
  const q = <T extends HTMLElement>(sel: string) => dlg.querySelector(sel) as T;
  const keySel = q<HTMLSelectElement>('#tr-key');
  const ivSel = q<HTMLSelectElement>('#tr-interval');
  const dirSel = q<HTMLSelectElement>('#tr-dir');
  const scopeSel = q<HTMLSelectElement>('#tr-scope');
  const note = q<HTMLElement>('#tr-note');
  for (let f = -7; f <= 7; f++) keySel.add(new Option(`${keyLabelJa(f)}（${f === 0 ? '調号なし' : Math.abs(f) + (f > 0 ? '♯' : '♭')}）`, String(f)));
  INTERVALS.forEach((iv, i) => ivSel.add(new Option(iv.label, String(i))));
  ivSel.value = '1';

  const mode = () => (dlg.querySelector<HTMLInputElement>('input[name="tr-mode"]:checked')?.value ?? 'key') as 'key' | 'interval';

  function interval(): Interval {
    const dir = dirSel.value as 'up' | 'down' | 'nearest';
    if (mode() === 'key') return intervalBetweenKeys(editor.score.keyFifths, Number(keySel.value), dir);
    const iv = INTERVALS[Number(ivSel.value)];
    const sign = dir === 'down' ? -1 : 1;
    return { steps: iv.steps * sign, semitones: iv.semitones * sign };
  }

  function scope(): TransposeScope {
    const v = scopeSel.value;
    if (v === 'all') return { kind: 'all' };
    if (v === 'sel') return { kind: 'ids', ids: editor.selectionIds() };
    return { kind: 'part', partIndex: Number(v.slice(5)) };
  }

  function update() {
    const isKey = mode() === 'key';
    q<HTMLElement>('#tr-key-row').hidden = !isKey;
    q<HTMLElement>('#tr-interval-row').hidden = isKey;
    dirSel.options[0].hidden = !isKey;
    if (!isKey && dirSel.value === 'nearest') dirSel.value = 'up';
    const iv = interval();
    const s = iv.semitones;
    const where = s === 0 ? '高さはそのまま（綴りだけ変える）' : `${Math.abs(s)}半音${s > 0 ? '上' : '下'}へ`;
    note.textContent = scopeSel.value === 'all'
      ? `${where}。調号も変わります（いま ${keyLabelJa(editor.score.keyFifths)}）。`
      : `${where}。調号はそのままで、臨時記号で書きます。`;
  }

  button.addEventListener('click', () => {
    scopeSel.innerHTML = '';
    scopeSel.add(new Option('楽譜全体', 'all'));
    editor.score.parts.forEach((p, i) => scopeSel.add(new Option(`譜表${i + 1}（${p.name}）だけ`, `part:${i}`)));
    const hasSel = editor.selected?.kind === 'note';
    if (hasSel) scopeSel.add(new Option('選んでいる音符だけ', 'sel'));
    scopeSel.value = 'all';
    keySel.value = String(editor.score.keyFifths);
    update();
    dlg.showModal();
  });
  dlg.addEventListener('change', update);
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    const sc = scope();
    const iv = interval();
    if (mode() === 'key' && sc.kind === 'all' && iv.semitones === 0 && iv.steps === 0) return;
    editor.transpose(iv, sc);
  });
}
