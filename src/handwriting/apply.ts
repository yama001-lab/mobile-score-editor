/**
 * 読み取った手書きの記号を、楽譜への編集に変える。
 * 位置の決め方はタップ入力と同じ：書いた位置（横）にある音符・休符を上書きし、
 * すでにある音符の真上・真下に書いた頭は和音として重ねる。
 */
import { Editor } from '../editor/editor';
import { MeasureHit, diatonicAtY } from '../render/render';
import { Recognized, StaffMetrics } from './recognize';

export interface ApplyResult {
  ok: boolean;
  /** 画面に出す短い説明 */
  message?: string;
}

/** VexFlow の音符のX（頭の左端）から頭の中心までのおおよその距離 */
const HEAD_HALF = 6;

export function staffOf(hit: MeasureHit): StaffMetrics {
  return { topLineY: hit.topLineY, lineSpacing: hit.lineSpacing };
}

function eventIndexAt(h: MeasureHit, x: number) {
  const i = h.events.findIndex((e) => x >= e.left && x < e.right);
  return i >= 0 ? i : h.events.length - 1;
}

/**
 * 書いた位置から入れる場所を決める。入力位置（青い帯）と同じ小節で、それより右に書いたときは
 * 入力位置に続けて入れる（入れるたびに小節の幅が変わっても、続けて書けるように）。
 * それより左や別の小節に書いたときは、その位置の音を上書きする。
 */
function placeCursor(editor: Editor, hit: MeasureHit, x: number) {
  const c = editor.cursor;
  if (c.partIndex === hit.partIndex && c.measureIndex === hit.measureIndex) {
    const ce = hit.events[Math.min(c.eventIndex, hit.events.length - 1)];
    if (ce && x >= ce.left) return; // 入力位置のまま
  }
  editor.setCursor({ partIndex: hit.partIndex, measureIndex: hit.measureIndex, eventIndex: eventIndexAt(hit, x) });
}

function eventsOf(editor: Editor, hit: MeasureHit) {
  return editor.score.parts[hit.partIndex].measures[hit.measureIndex].events;
}

/** 記号を楽譜に入れる。hit は記号を書いた小節（五線） */
export function applyRecognized(editor: Editor, r: Recognized, hit: MeasureHit, allHits: MeasureHit[] = [hit]): ApplyResult {
  const s = hit.lineSpacing;
  const evs = eventsOf(editor, hit);
  switch (r.kind) {
    case 'note': {
      const pos = diatonicAtY(hit, r.headY);
      // すでにある音符の真上・真下 → 和音
      const aligned = hit.events.find((e, i) => evs[i]?.kind === 'note' && Math.abs(e.x + HEAD_HALF - r.headX) < s * 1.1);
      if (aligned) {
        editor.select(aligned.id);
        editor.inputDiatonic(pos, r.alter, true);
        return { ok: true, message: '和音に重ねました' };
      }
      placeCursor(editor, hit, r.headX);
      if (r.duration) editor.setInputDuration(r.duration);
      const savedDots = editor.inputDots;
      if (r.duration || r.dots) editor.inputDots = r.dots;
      try {
        editor.inputDiatonic(pos, r.alter);
      } finally {
        editor.inputDots = savedDots;
      }
      return { ok: true };
    }
    case 'rest': {
      placeCursor(editor, hit, r.x);
      editor.setInputDuration(r.duration);
      const savedDots = editor.inputDots;
      editor.inputDots = r.dots;
      try {
        editor.inputRest();
      } finally {
        editor.inputDots = savedDots;
      }
      return { ok: true };
    }
    case 'accidental': {
      // すぐ右にある音符に付ける。なければ直前に入れた（選択中の）音符
      const target = hit.events.find((e, i) => evs[i]?.kind === 'note' && e.x >= r.box.x1 - s * 0.5 && e.x - r.box.x1 < s * 3);
      if (target) {
        const heads = target.headYs;
        const cy = (r.box.y0 + r.box.y1) / 2;
        let pi = 0;
        heads.forEach((y, i) => { if (Math.abs(y - cy) < Math.abs(heads[pi] - cy)) pi = i; });
        editor.select(target.id, pi);
      }
      if (editor.selected?.kind !== 'note') return { ok: false, message: '臨時記号を付ける音符が見つかりません' };
      editor.setSelectedAccidental(r.alter);
      return { ok: true };
    }
    case 'dot': {
      // すぐ左の音符・休符を付点にする
      let ti = -1;
      hit.events.forEach((e, i) => { if (e.x < r.x - s * 0.3 && r.x - e.x < s * 3.2) ti = i; });
      if (ti < 0) return { ok: false };
      const ev = evs[ti];
      editor.select(ev.id);
      editor.setSelectedDuration(ev.duration, 1);
      // 入力位置は付点にした音の次へ
      const loc = editor.selectedLocation;
      if (loc) {
        const m = editor.score.parts[loc.partIndex].measures[loc.measureIndex];
        const atEnd = loc.eventIndex + 1 >= m.events.length;
        editor.setCursor(atEnd && loc.measureIndex + 1 < editor.score.parts[0].measures.length
          ? { partIndex: loc.partIndex, measureIndex: loc.measureIndex + 1, eventIndex: 0 }
          : { ...loc, eventIndex: Math.min(loc.eventIndex + 1, m.events.length - 1) });
      }
      return { ok: true };
    }
    case 'erase': {
      const ids: string[] = [];
      for (const h of allHits) {
        if (h.partIndex !== hit.partIndex) continue;
        const top = h.topLineY - s * 3, bottom = h.topLineY + s * 7;
        if (r.box.y1 < top || r.box.y0 > bottom) continue;
        const hevs = eventsOf(editor, h);
        h.events.forEach((e, i) => {
          const cx = e.x + HEAD_HALF;
          if (hevs[i]?.kind === 'note' && cx >= r.box.x0 - s * 0.3 && cx <= r.box.x1 + s * 0.3) ids.push(e.id);
        });
      }
      if (!ids.length) return { ok: false, message: '消す音符がありません' };
      editor.eraseEvents(ids);
      return { ok: true, message: ids.length > 1 ? `${ids.length}個の音符を消しました` : '音符を消しました' };
    }
    default:
      return { ok: false, message: '読み取れませんでした。もう少し大きく、五線の間隔に合わせて書いてみてください' };
  }
}
