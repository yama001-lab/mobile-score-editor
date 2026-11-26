/** 圧縮 MusicXML（.mxl = zip）から楽譜本体の XML を取り出す。Audiveris の標準の書き出し形式。 */
import { strFromU8, unzipSync } from 'fflate';

export function unzipMusicXml(bytes: Uint8Array): string {
  const files = unzipSync(bytes);
  const container = files['META-INF/container.xml'];
  if (container) {
    const m = /full-path\s*=\s*"([^"]+)"/.exec(strFromU8(container));
    if (m && files[m[1]]) return strFromU8(files[m[1]]);
  }
  const name = Object.keys(files).find((n) => !n.startsWith('META-INF/') && /\.(musicxml|xml)$/i.test(n));
  if (!name) throw new Error('.mxl の中に楽譜（MusicXML）が見つかりませんでした');
  return strFromU8(files[name]);
}
