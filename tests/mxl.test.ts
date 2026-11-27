import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { unzipMusicXml } from '../src/import/mxl';

describe('.mxl（圧縮 MusicXML）', () => {
  it('container.xml が指す楽譜を取り出す', () => {
    const zip = zipSync({
      'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="music/score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>'),
      'music/score.musicxml': strToU8('<score-partwise>楽譜</score-partwise>'),
      'other.xml': strToU8('<x/>'),
    });
    expect(unzipMusicXml(zip)).toBe('<score-partwise>楽譜</score-partwise>');
  });
  it('container.xml がなくても XML を探す', () => {
    const zip = zipSync({ 'a.xml': strToU8('<score-partwise/>') });
    expect(unzipMusicXml(zip)).toBe('<score-partwise/>');
  });
});
