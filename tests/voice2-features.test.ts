// @vitest-environment jsdom
// 範囲コピー・貼り付け、スラー、歌詞を声部2でも使えること
import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor/editor';
import { toMusicXml } from '../src/export/musicxml';
import { parseMusicXml } from '../src/import/musicxml';
import { resolveSpanners } from '../src/model/marks';
import { MusicEvent, NoteEvent, createScore, measureTicks } from '../src/model/score';
import { partVerses, stepLyricTarget } from '../src/model/texts';
import { renderScore } from '../src/render/render';

const C4 = 28;
const names = (evs: MusicEvent[] | undefined) =>
  (evs ?? []).map((ev) => (ev.kind === 'rest' ? `r${ev.duration}` : ev.pitches.map((p) => p.step + p.octave).join('+') + ev.duration + (ev.tie ? '~' : '')));
const v1 = (e: Editor, mi: number) => names(e.score.parts[0].measures[mi].events);
const v2 = (e: Editor, mi: number) => names(e.score.parts[0].measures[mi].voice2);
const full = (e: Editor) => e.score.parts.every((p) => p.measures.every((m) =>
  measureTicks(m) === e.capacity && (!m.voice2 || measureTicks({ ...m, events: m.voice2 }) === e.capacity)));

/** 1小節目：声部1に G4 A4（2分）、声部2に C4 D4 E4 F4（4分） */
function twoVoices() {
  const e = new Editor(createScore());
  e.setInputDuration('h');
  e.inputDiatonic(C4 + 4);
  e.inputDiatonic(C4 + 5);
  e.setCursor({ partIndex: 0, measureIndex: 0, eventIndex: 0 });
  e.setVoice(1);
  e.setInputDuration('q');
  for (const d of [0, 1, 2, 3]) e.inputDiatonic(C4 + d);
  e.setVoice(0);
  e.setMode('select');
  return e;
}
const v2Id = (e: Editor, mi: number, ei: number) => e.score.parts[0].measures[mi].voice2![ei].id;

describe('声部2：範囲コピー・貼り付け', () => {
  it('小節の範囲をコピーすると声部2も一緒に貼られる', () => {
    const e = twoVoices();
    e.selectMeasures(0, 0, 0, 0);
    expect(e.rangeIds!.size).toBe(6);
    expect(e.copy()).toBe(true);
    expect(e.clipboard!.voice2).toBeTruthy();
    e.selectMeasures(0, 0, 2, 2);
    e.paste();
    expect(v1(e, 2)).toEqual(['G4h', 'A4h']);
    expect(v2(e, 2)).toEqual(['C4q', 'D4q', 'E4q', 'F4q']);
    expect(full(e)).toBe(true);
  });

  it('拍の途中で切った範囲でも、声部2は休符を分けて正しく貼る', () => {
    const e = twoVoices();
    // 2拍目から3拍目まで（声部1は2分音符の途中で切れる）
    e.setRange({ partFrom: 0, partTo: 0, start: 480, end: 1440 });
    e.copy();
    e.selectMeasures(0, 0, 1, 1);
    e.paste();
    expect(v1(e, 1)).toEqual(['G4q', 'A4q', 'rh']);
    expect(v2(e, 1)).toEqual(['D4q', 'E4q', 'rh']);
    expect(full(e)).toBe(true);
  });

  it('声部2のない範囲を貼ると、貼り先の声部2は消える', () => {
    const e = twoVoices();
    e.selectMeasures(0, 0, 1, 1); // 空の小節
    e.copy();
    expect(e.clipboard!.voice2).toBeUndefined();
    e.selectMeasures(0, 0, 0, 0);
    e.paste();
    expect(e.score.parts[0].measures[0].voice2).toBeUndefined();
  });

  it('範囲を消すと声部2も休符になり、声部2はなくなる', () => {
    const e = twoVoices();
    e.selectMeasures(0, 0, 0, 0);
    e.deleteRange();
    expect(v1(e, 0)).toEqual(['rw']);
    expect(e.score.parts[0].measures[0].voice2).toBeUndefined();
  });

  it('声部2の1音をコピーして声部2の別の音に貼ると、声部2だけが変わる', () => {
    const e = twoVoices();
    e.select(v2Id(e, 0, 0)); // C4
    e.copy();
    expect(e.clipboard!.voice).toBe(1);
    e.select(v2Id(e, 0, 3)); // F4 の所へ
    e.paste();
    expect(v2(e, 0)).toEqual(['C4q', 'D4q', 'E4q', 'C4q']);
    expect(v1(e, 0)).toEqual(['G4h', 'A4h']);
  });

  it('声部2の1音を切り取ると、その音だけ休符になる', () => {
    const e = twoVoices();
    e.select(v2Id(e, 0, 1));
    e.cut();
    expect(v2(e, 0)).toEqual(['C4q', 'rq', 'E4q', 'F4q']);
    expect(v1(e, 0)).toEqual(['G4h', 'A4h']);
  });

  it('入力モードで声部2の入力位置に貼ると声部2に入り、入力位置はその後ろ', () => {
    const e = twoVoices();
    e.select(v2Id(e, 0, 0));
    e.copy();
    e.setMode('input');
    e.setCursor({ partIndex: 0, measureIndex: 1, eventIndex: 0 });
    e.setVoice(1);
    e.paste();
    expect(v2(e, 1)).toEqual(['C4q', 'rh']); // 付点2分休符
    expect(e.score.parts[0].measures[1].voice2![1].dots).toBe(1);
    expect(v1(e, 1)).toEqual(['rw']);
    expect(e.cursor).toEqual({ partIndex: 0, measureIndex: 1, eventIndex: 1, voice: 1 });
  });

  it('範囲の上下移動は声部2の音も動かす', () => {
    const e = twoVoices();
    e.selectMeasures(0, 0, 0, 0);
    e.transposeSelected(1);
    expect(v1(e, 0)).toEqual(['A4h', 'B4h']);
    expect(v2(e, 0)).toEqual(['D4q', 'E4q', 'F4q', 'G4q']);
  });
});

describe('声部2：スラー', () => {
  it('声部2の音から、声部2の次の音へスラーを付ける（声部1へはつながない）', () => {
    const e = twoVoices();
    const a = v2Id(e, 0, 0);
    e.select(a);
    e.toggleSpanner('slur');
    const rs = resolveSpanners(e.score);
    expect(rs).toHaveLength(1);
    expect(rs[0].voice).toBe(1);
    expect(rs[0].spanner.from).toBe(a);
    expect(rs[0].spanner.to).toBe(v2Id(e, 0, 1));
    // 続けて押すと声部2の中で伸びる
    e.toggleSpanner('slur');
    expect(resolveSpanners(e.score)[0].spanner.to).toBe(v2Id(e, 0, 2));
  });

  it('声部1と声部2のスラーは重なっても両方残る', () => {
    const e = twoVoices();
    e.select(v2Id(e, 0, 0));
    e.toggleSpanner('slur');
    e.select(e.score.parts[0].measures[0].events[0].id);
    e.toggleSpanner('slur');
    expect(resolveSpanners(e.score).map((r) => r.voice).sort()).toEqual([0, 1]);
  });

  it('入力モード：声部2で続けて入れた音にスラーを付けられる', () => {
    const e = new Editor(createScore());
    e.setMode('input');
    e.setVoice(1);
    e.inputDiatonic(C4);
    e.inputDiatonic(C4 + 1);
    e.toggleSpanner('slur');
    const rs = resolveSpanners(e.score);
    expect(rs).toHaveLength(1);
    expect(rs[0].voice).toBe(1);
  });

  it('声部をまたぐスラー（古いデータなど）は無効として扱う', () => {
    const e = twoVoices();
    e.score.spanners = [{ id: 'x', kind: 'slur', from: e.score.parts[0].measures[0].events[0].id, to: v2Id(e, 0, 3) }];
    expect(resolveSpanners(e.score)).toHaveLength(0);
  });

  it('声部2のスラーは MusicXML で書き出して読み戻せ、描画もできる', () => {
    const e = twoVoices();
    e.select(v2Id(e, 0, 0));
    e.toggleSpanner('slur');
    e.select(e.score.parts[0].measures[0].events[0].id);
    e.toggleSpanner('slur');
    const back = parseMusicXml(toMusicXml(e.score)).score;
    const rs = resolveSpanners(back);
    expect(rs.map((r) => r.voice).sort()).toEqual([0, 1]);
    const r2 = rs.find((r) => r.voice === 1)!;
    expect(names([r2.from.ev, r2.to.ev])).toEqual(['C4q', 'D4q']);

    (window.SVGElement.prototype as unknown as { getBBox: () => object }).getBBox = () => ({ x: 0, y: 0, width: 40, height: 12 });
    const el = document.createElement('div');
    expect(() => renderScore(el, e.score, { width: 600 })).not.toThrow();
  });
});

describe('声部2：歌詞', () => {
  function withLyrics() {
    const e = twoVoices();
    const m = e.score.parts[0].measures[0];
    e.setLyric(m.events[0].id, 0, 'そ');
    e.setLyric(m.voice2![0].id, 0, 'あ-');
    e.setLyric(m.voice2![1].id, 0, 'め');
    return e;
  }

  it('声部2の音符に歌詞を付け、次の音符へは声部2の中で進む', () => {
    const e = withLyrics();
    const m = e.score.parts[0].measures[0];
    expect((m.voice2![0] as NoteEvent).lyrics).toEqual(['あ-']);
    expect(stepLyricTarget(e.score, 0, m.voice2![0].id, 1)).toBe(m.voice2![1].id);
    expect(stepLyricTarget(e.score, 0, m.voice2![3].id, 1)).toBeNull();
    expect(stepLyricTarget(e.score, 0, m.events[0].id, 1)).toBe(m.events[1].id);
    expect(partVerses(e.score, 0)).toBe(1);
    expect(partVerses(e.score, 0, 1)).toBe(1);
  });

  it('声部2の歌詞は声部1の歌詞の下の行に描く', () => {
    const e = withLyrics();
    (window.SVGElement.prototype as unknown as { getBBox: () => object }).getBBox = () => ({ x: 0, y: 0, width: 20, height: 12 });
    const el = document.createElement('div');
    const res = renderScore(el, e.score, { width: 800, drawTitle: false });
    const m = e.score.parts[0].measures[0];
    const hit = (id: string) => res.textHits.find((h) => h.kind === 'lyric' && h.eventId === id)!;
    expect(hit(m.voice2![0].id)).toBeTruthy();
    expect(hit(m.voice2![0].id).y).toBeGreaterThan(hit(m.events[0].id).y);
    expect(hit(m.voice2![0].id).verse).toBe(0);
  });

  it('声部2の歌詞（ハイフンも）は MusicXML で書き出して読み戻せる', () => {
    const e = withLyrics();
    const xml = toMusicXml(e.score);
    // 声部ごとにハイフンのつながりを数える（声部1の「そ」は single のまま）
    expect(xml).toContain('<syllabic>single</syllabic><text>そ</text>');
    expect(xml).toContain('<syllabic>begin</syllabic><text>あ</text>');
    expect(xml).toContain('<syllabic>end</syllabic><text>め</text>');
    const back = parseMusicXml(xml).score.parts[0].measures[0];
    expect(back.voice2!.map((x) => (x as NoteEvent).lyrics?.[0] ?? '')).toEqual(['あ-', 'め', '', '']);
    expect((back.events[0] as NoteEvent).lyrics).toEqual(['そ']);
  });
});
