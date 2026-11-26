/** PDF書き出し。楽譜はベクターのまま、日本語のタイトルは画像にして載せる（PDF標準フォントに日本語がないため）。 */
import { Score } from '../model/score';
import { layoutSystems, paginate, renderPage } from '../render/render';

const PAGE_W = 794; // A4 を 96dpi で表した幅
const PAGE_H = 1123;
const PT_W = 595.28;
const PT_H = 841.89;
const TOP = 40;

function titleImage(score: Score): string {
  const scale = 3;
  const canvas = document.createElement('canvas');
  canvas.width = PAGE_W * scale;
  canvas.height = 110 * scale;
  const g = canvas.getContext('2d')!;
  g.scale(scale, scale);
  g.fillStyle = '#000';
  g.textBaseline = 'alphabetic';
  g.font = 'bold 26px "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif';
  g.textAlign = 'center';
  g.fillText(score.title, PAGE_W / 2, TOP + 40);
  g.font = '14px "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif';
  if (score.composer) {
    g.textAlign = 'right';
    g.fillText(score.composer, PAGE_W - 24, TOP + 72);
  }
  g.textAlign = 'left';
  g.font = '12px serif';
  g.fillText(`♩ = ${score.tempo}`, 24, TOP + 72);
  return canvas.toDataURL('image/png');
}

export async function exportPdf(score: Score): Promise<void> {
  const [{ jsPDF }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait', compress: true });
  const opts = { width: PAGE_W, pageHeight: PAGE_H, drawTitle: false };
  const pages = paginate(score, layoutSystems(score, opts), PAGE_H, TOP);
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;';
  document.body.appendChild(holder);
  try {
    for (let i = 0; i < pages.length; i++) {
      if (i > 0) doc.addPage();
      const div = document.createElement('div');
      holder.appendChild(div);
      renderPage(div, score, pages[i], opts, i, TOP);
      const svg = div.querySelector('svg')!;
      await doc.svg(svg, { x: 0, y: 0, width: PT_W, height: PT_H });
      if (i === 0) doc.addImage(titleImage(score), 'PNG', 0, 0, PT_W, (110 * PT_W) / PAGE_W, undefined, 'FAST');
      div.remove();
    }
    const name = (score.title || 'score').replace(/[\\/:*?"<>|]/g, '_') + '.pdf';
    downloadBlob(doc.output('blob'), name);
  } finally {
    holder.remove();
  }
}

function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
