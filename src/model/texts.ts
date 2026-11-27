/**
 * 歌詞・コードネーム・文字・練習番号まわりの共通処理（データの形は score.ts の EventTexts）。
 * 画面の入力（src/ui/text-entry.ts）、描画、MusicXML の読み書きから使う。
 */
import { Step } from './pitch';
import { MusicEvent, NoteEvent, Score } from './score';

/** 歌詞を入れられる最大の番の数 */
export const MAX_VERSES = 5;

// ---------- 歌詞 ----------

export function lyricOf(e: MusicEvent, verse: number): string {
  return (e.kind === 'note' && e.lyrics?.[verse]) || '';
}

/** 歌詞を設定する（空なら消す）。配列の後ろの空きは詰める */
export function setLyricOn(e: NoteEvent, verse: number, text: string): void {
  const lyrics = [...(e.lyrics ?? [])];
  while (lyrics.length <= verse) lyrics.push('');
  lyrics[verse] = text;
  while (lyrics.length && !lyrics[lyrics.length - 1]) lyrics.pop();
  if (lyrics.length) e.lyrics = lyrics;
  else delete e.lyrics;
}

/** 歌詞の表示用の文字と、次の音節へハイフンでつなぐか */
export function splitSyllable(raw: string): { text: string; hyphen: boolean } {
  const hyphen = /[-‐]$/.test(raw) && raw.length > 1;
  return { text: hyphen ? raw.slice(0, -1) : raw, hyphen };
}

export function maxVerses(score: Score): number {
  let n = 0;
  for (const p of score.parts) for (const m of p.measures) for (const e of m.events)
    if (e.kind === 'note' && e.lyrics) n = Math.max(n, e.lyrics.length);
  return n;
}

export function partVerses(score: Score, partIndex: number): number {
  let n = 0;
  for (const m of score.parts[partIndex]?.measures ?? []) for (const e of m.events)
    if (e.kind === 'note' && e.lyrics) n = Math.max(n, e.lyrics.length);
  return n;
}

/** パートの中のイベントを、曲の頭から順に並べる */
export function partEvents(score: Score, partIndex: number): { ev: MusicEvent; measureIndex: number; eventIndex: number }[] {
  const out: { ev: MusicEvent; measureIndex: number; eventIndex: number }[] = [];
  score.parts[partIndex]?.measures.forEach((m, measureIndex) =>
    m.events.forEach((ev, eventIndex) => out.push({ ev, measureIndex, eventIndex })));
  return out;
}

/**
 * 歌詞を入れる次（delta=-1 なら前）の音符。休符と、タイでつながった後ろの音符はとばす。
 * 見つからなければ null
 */
export function stepLyricTarget(score: Score, partIndex: number, fromId: string, delta: 1 | -1): string | null {
  const list = partEvents(score, partIndex);
  const i = list.findIndex((x) => x.ev.id === fromId);
  if (i < 0) return null;
  const tiedFromPrev = (k: number) => {
    const prev = list[k - 1]?.ev;
    return !!prev && prev.kind === 'note' && !!prev.tie;
  };
  for (let k = i + delta; k >= 0 && k < list.length; k += delta) {
    const ev = list[k].ev;
    if (ev.kind === 'note' && !tiedFromPrev(k)) return ev.id;
  }
  return null;
}

/** コードネームの次（前）の入力位置。休符にも付けられるので、すべての音符・休符を順にたどる */
export function stepEventTarget(score: Score, partIndex: number, fromId: string, delta: 1 | -1): string | null {
  const list = partEvents(score, partIndex);
  const i = list.findIndex((x) => x.ev.id === fromId);
  const k = i + delta;
  if (i < 0 || k < 0 || k >= list.length) return null;
  return list[k].ev.id;
}

// ---------- コードネーム ----------

export interface ParsedChord {
  root: { step: Step; alter: number };
  /** ルートのあとの部分（"m7", "sus4" など）。表示はこのまま */
  suffix: string;
  bass?: { step: Step; alter: number };
  /** MusicXML の kind */
  kind: string;
}

const ROOT_RE = /^([A-Ga-g])([#♯]|[b♭])?/;

function parseRoot(s: string): { step: Step; alter: number; rest: string } | null {
  const m = ROOT_RE.exec(s);
  if (!m) return null;
  const alter = !m[2] ? 0 : /[#♯]/.test(m[2]) ? 1 : -1;
  return { step: m[1].toUpperCase() as Step, alter, rest: s.slice(m[0].length) };
}

/** 主なコードの種類（MusicXML の kind）。それ以外は "other" にして、文字はそのまま渡す */
const KINDS: [RegExp, string][] = [
  [/^(|M|maj)$/, 'major'],
  [/^(m|min|-)$/, 'minor'],
  [/^7$/, 'dominant'],
  [/^(M7|maj7|Maj7|△7|△|Δ7|Δ)$/, 'major-seventh'],
  [/^(m7|min7|-7)$/, 'minor-seventh'],
  [/^(dim|o|°)$/, 'diminished'],
  [/^(dim7|o7|°7)$/, 'diminished-seventh'],
  [/^(aug|\+|\+5)$/, 'augmented'],
  [/^(aug7|\+7|7\+5|7#5)$/, 'augmented-seventh'],
  [/^(m7-5|m7b5|m7♭5|ø|ø7)$/, 'half-diminished'],
  [/^(mM7|m\(maj7\)|mmaj7|m△7)$/, 'major-minor'],
  [/^(6|M6)$/, 'major-sixth'],
  [/^m6$/, 'minor-sixth'],
  [/^9$/, 'dominant-ninth'],
  [/^(M9|maj9)$/, 'major-ninth'],
  [/^m9$/, 'minor-ninth'],
  [/^11$/, 'dominant-11th'],
  [/^13$/, 'dominant-13th'],
  [/^sus2$/, 'suspended-second'],
  [/^(sus4|sus)$/, 'suspended-fourth'],
  [/^5$/, 'power'],
];

/** "F#m7/C#" のような文字をルート・種類・ベースに分ける。読めなければ null */
export function parseChord(raw: string): ParsedChord | null {
  const s = raw.trim();
  const r = parseRoot(s);
  if (!r) return null;
  let suffix = r.rest;
  let bass: ParsedChord['bass'];
  const slash = suffix.lastIndexOf('/');
  if (slash >= 0) {
    const b = parseRoot(suffix.slice(slash + 1));
    if (b && !b.rest) {
      bass = { step: b.step, alter: b.alter };
      suffix = suffix.slice(0, slash);
    }
  }
  const kind = KINDS.find(([re]) => re.test(suffix))?.[1] ?? 'other';
  return { root: { step: r.step, alter: r.alter }, suffix, bass, kind };
}

const ACC = (alter: number) => (alter > 0 ? '♯' : alter < 0 ? '♭' : '');

/** 表示用：# と b を ♯ ♭ にする（"Bb7" → "B♭7"）。読めない文字はそのまま */
export function formatChord(raw: string): string {
  const c = parseChord(raw);
  if (!c) return raw.trim();
  const suffix = c.suffix.replace(/(^|[^a-z])b(?=\d)/g, '$1♭').replace(/#(?=\d)/g, '♯');
  return `${c.root.step}${ACC(c.root.alter)}${suffix}${c.bass ? `/${c.bass.step}${ACC(c.bass.alter)}` : ''}`;
}

/** MusicXML の kind からルートのあとの文字を作る（kind の text 属性がないとき用） */
export const KIND_SUFFIX: Record<string, string> = {
  major: '', minor: 'm', augmented: 'aug', diminished: 'dim', dominant: '7', 'major-seventh': 'M7',
  'minor-seventh': 'm7', 'diminished-seventh': 'dim7', 'augmented-seventh': 'aug7', 'half-diminished': 'm7-5',
  'major-minor': 'mM7', 'major-sixth': '6', 'minor-sixth': 'm6', 'dominant-ninth': '9', 'major-ninth': 'M9',
  'minor-ninth': 'm9', 'dominant-11th': '11', 'major-11th': 'M11', 'minor-11th': 'm11', 'dominant-13th': '13',
  'major-13th': 'M13', 'minor-13th': 'm13', 'suspended-second': 'sus2', 'suspended-fourth': 'sus4', power: '5',
  none: '', other: '',
};

// ---------- 練習番号 ----------

/** 次に付ける練習番号（A, B, … Z, AA …）。今ある最後の文字の次 */
export function nextRehearsal(score: Score, beforeMeasure: number): string {
  const marks = score.parts[0].measures.slice(0, beforeMeasure).map((m) => m.rehearsal).filter((r): r is string => !!r);
  const last = marks[marks.length - 1];
  if (!last) return 'A';
  if (/^\d+$/.test(last)) return String(Number(last) + 1);
  if (/^[A-Y]$/.test(last)) return String.fromCharCode(last.charCodeAt(0) + 1);
  if (last === 'Z') return 'AA';
  return last + "'";
}
