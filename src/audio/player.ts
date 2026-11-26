/**
 * 再生。少し先までの音だけを順に予約していく（長い曲でも一度に大量の音を作らない）。
 * 再生位置は onMark で知らせ、画面側で楽譜上に印を出す。
 */
import { Score } from '../model/score';
import { ScheduledMark, buildSchedule } from './schedule';
import { Voice, audioContext, playNote, unlock } from './synth';

const LOOKAHEAD = 0.4;
const TICK_MS = 60;

export interface PlayOptions {
  fromMeasure?: number;
  /** 再生位置が次の音符に進んだとき（パートごと） */
  onMark?: (mark: ScheduledMark) => void;
  onEnd?: () => void;
}

export class Player {
  private timer = 0;
  private raf = 0;
  private voices: Voice[] = [];
  private onEnd: (() => void) | null = null;
  playing = false;

  play(score: Score, opts: PlayOptions = {}) {
    this.stop();
    unlock();
    const c = audioContext();
    if (!c) return false;
    const sched = buildSchedule(score, opts.fromMeasure ?? 0);
    const t0 = c.currentTime + 0.12;
    let ni = 0;
    let mi = 0;
    this.playing = true;
    this.onEnd = opts.onEnd ?? null;
    const pump = () => {
      const horizon = c.currentTime + LOOKAHEAD - t0;
      while (ni < sched.notes.length && sched.notes[ni].time < horizon) {
        const n = sched.notes[ni++];
        // 同じ高さの音が続くとき聞き分けられるよう、ほんの少し短くする
        const v = playNote(n.instrument, n.midi, t0 + n.time, Math.max(0.05, n.duration - 0.02), 0.75);
        if (v) this.voices.push(v);
      }
      if (this.voices.length > 200) this.voices.splice(0, this.voices.length - 200);
    };
    const follow = () => {
      const now = c.currentTime - t0;
      while (mi < sched.marks.length && sched.marks[mi].time <= now) opts.onMark?.(sched.marks[mi++]);
      if (now >= sched.length + 0.1) {
        this.finish();
        return;
      }
      this.raf = requestAnimationFrame(follow);
    };
    pump();
    this.timer = window.setInterval(pump, TICK_MS);
    this.raf = requestAnimationFrame(follow);
    return true;
  }

  private finish() {
    clearInterval(this.timer);
    cancelAnimationFrame(this.raf);
    this.playing = false;
    const cb = this.onEnd;
    this.onEnd = null;
    cb?.();
  }

  stop() {
    if (!this.playing) return;
    for (const v of this.voices) v.stop();
    this.voices = [];
    this.finish();
  }
}
