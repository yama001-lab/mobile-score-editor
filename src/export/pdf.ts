/** PDF書き出し。楽譜はベクターのまま、日本語のタイトルは画像にして載せる（PDF標準フォントに日本語がないため）。 */
import { Score } from '../model/score';
import { layoutSystems, paginate, renderPage } from '../render/render';
import { encodeScore } from '../import/embed';
import { TextItem, cssFont } from '../render/texts';

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

/** 文字1つを、透明な背景の画像にする（座標は楽譜の論理px） */
function textImage(t: TextItem): { url: string; x: number; y: number; w: number; h: number } | null {
  const scale = 4;
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.font = cssFont(t.font);
  const pad = 2;
  const w = Math.ceil(g.measureText(t.text).width) + pad * 2;
  const ascent = t.font.size * 1.05;
  const h = Math.ceil(t.font.size * 1.4) + pad * 2;
  canvas.width = w * scale;
  canvas.height = h * scale;
  g.scale(scale, scale);
  g.font = cssFont(t.font);
  g.fillStyle = '#000';
  g.textBaseline = 'alphabetic';
  g.fillText(t.text, pad, pad + ascent);
  return { url: canvas.toDataURL('image/png'), x: t.x - pad, y: t.y - ascent - pad, w, h };
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
      // 歌詞などの文字は日本語を含むので、SVG には描かずに集めて画像で載せる
      const texts: TextItem[] = [];
      renderPage(div, score, pages[i], { ...opts, textSink: (t) => texts.push(t) }, i, TOP);
      const svg = div.querySelector('svg')!;
      await doc.svg(svg, { x: 0, y: 0, width: PT_W, height: PT_H });
      for (const t of texts) {
        const img = textImage(t);
        if (!img) continue;
        const k = PT_W / PAGE_W;
        doc.addImage(img.url, 'PNG', img.x * k, img.y * k, img.w * k, img.h * k, undefined, 'FAST');
      }
      if (i === 0) doc.addImage(titleImage(score), 'PNG', 0, 0, PT_W, (110 * PT_W) / PAGE_W, undefined, 'FAST');
      div.remove();
    }
    // 楽譜データを埋め込んでおき、このPDFを「取り込む」と元の楽譜に戻せるようにする
    doc.setProperties({ creator: 'mobile-score-editor', keywords: encodeScore(score) });
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
