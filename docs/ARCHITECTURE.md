# 設計メモ

## データの流れ

```
入力（タップ／キーボード／鍵盤／手書き／PDF取り込み）
        │
        ▼
   Editor（src/editor/editor.ts） ── 元に戻す用のスナップショット
        │ 変更通知
        ├──▶ render（VexFlowでSVG描画） ──▶ 画面 / PDF
        └──▶ storage（localStorageに自動保存。バックアップは src/storage/backup.ts）
```

楽譜データ（`src/model/score.ts`）は JSON にそのまま書ける形で、`schemaVersion` を持ちます。
形を変えるときは `schemaVersion` を上げ、`src/storage/local.ts` の `migrate()` に変換を足します。

- 長さはティック（4分音符 = 480、MIDIと同じ）
- 音高は `{ step, alter, octave }`。`toMidi()` / `fromMidi()` で MIDI 番号と変換
- 全パートの小節数は常に同じ。小節はいつも音符と休符でちょうど埋まっている
- 1段に声部は2つまで。`Measure.events` が声部1、省略できる `Measure.voice2` が声部2（どちらも小節をちょうど埋める）。
  声部2が休符だけになったら `normalizeMeasure()` が消すので、古いデータ・声部2のない小節は今までと同じ形。
  声部を問わず読むときは `voiceEvents(m, voice)`（なければ空）、書き換える前は `ensureVoice()`、全声部をなめるときは `measureEvents(m)`。
  `EventLocation` / `Cursor` の `voice`（省略=0）で声部を指す。音符に新しい情報を足す機能（連符・歌詞など）も、声部2の音に同じように付く

### 小節ごとの記号と弱起

- `Score.measureAttrs`：小節番号つきで、その小節からの拍子（`timeSignature`）・調号（`keyFifths`）の変更、
  リピート（`repeatStart` / `repeatEnd` / `repeatTimes`）、番号付きカッコ（`volta`）を持つ。全パート共通
- `Score.pickup`：弱起。1小節目の長さ（ティック）
- 小節の長さ・拍子・調号は必ず `capacityAt()` / `timeSigAt()` / `keyAt()` で小節ごとに求める
  （`score.timeSignature` / `score.keyFifths` は曲頭の値）
- 小節を足す・消すときは `shiftMeasureMarks()` でテンポ変更と小節の記号の番号をずらす
- 再生の順番は `playOrder()`（リピートと番号付きカッコをたどる）。`buildSchedule()` はこの順に鳴らす
- 途中の拍子変更は `Editor.setTimeSignatureAt()`。その小節から次の拍子変更の手前までを引き直す
- 途中の調号変更 `Editor.setKeyAt()` は音の高さを変えない

### 保存の安全策（`src/storage/backup.ts`）

- 起動時に `navigator.storage.persist()` で「消さないで」と頼む（Safari はホーム画面から開くと日数でデータを消さない）
- ファイル画面の「すべての楽譜をバックアップ」：全曲を1つの JSON（`format: "mobile-score-editor-backup"`）にまとめ、
  タッチ端末では共有シート（「"ファイル"に保存」）、それ以外はダウンロード（`saveFileToDevice()`）
- 「バックアップから戻す」：同じ id の楽譜は新しいほうを残す（`planRestore()`）。1曲だけの .json も読める
- 最後のバックアップ時刻は `score-editor:backup-at`。そのあと書き換えがあり7日たったら上に声かけを出す（`shouldRemindBackup()`）
- 保存に失敗したら（容量いっぱいなど）上のバーで知らせる。画面を離れるときは待っている自動保存をすぐ済ませる

## 画面の配置

- `header.topbar`：アプリ全体の操作（ファイル・再生・元に戻す・設定・書き出し）
- `#stage`：楽譜（`#score-wrap`）と、その上に浮かぶ表示倍率・モードの説明・お知らせ（`toast()`）
- `footer#dock`：道具バー（`.modes` に入力方法、`#palette` に道具のグループ）と入力パネル（`#input-panel`）
- アイコンは `src/ui/icons.ts`。HTML で `data-icon="名前"` を付けると `applyIcons()` が入れる

道具を足すときは `#palette` に `.group` を足すか、既存のグループに `button.tool`（アイコン＋短い名前）を足す。
ポップアップのメニューは `#measure-menu` と同じ形で作れる。

## 範囲選択とコピー・貼り付け

- `src/editor/range.ts`：範囲は「パートの範囲 × 曲頭からのティック（start〜end）」（`RangeSel`）。
  パートごとに音の区切りが違っても、範囲の端で音を分け（`splitPartAt`、音符はタイでつなぐ）、
  `writeEvents()` で上書きする。小節線をまたぐ音はタイで分ける。範囲外へのタイはコピーに持ち出さない
- `Editor` の `range` / `copy()` / `cut()` / `paste()` / `deleteRange()`。範囲を使わない編集操作をすると範囲は解ける。
  貼る位置は「範囲の頭 → 選択中の音 → （入力モードでは）入力位置」
- 範囲は両方の声部を含む（MuseScore と同じ）。コピーは `Clip.parts`（声部1）と `Clip.voice2`（声部2、休符だけなら null）。
  貼るときは声部1→声部1、声部2→声部2で、コピーに声部2がなければ貼り先の声部2は休符になる（休符だけなら消える）。
  1音だけを選んでのコピー・切り取り・削除はその音の声部だけ（`RangeSel.voice` / `Clip.voice`）で、貼り先の音（入力位置）の声部へ貼る。
  `range.ts` の `placed` / `splitPartAt` / `writeEvents` は `voice` 引数で声部を選ぶ（声部2のない小節は休符で作ってから書く）
- 画面：選択モードで長押ししてなぞる、「範囲」ボタンを押してからタップ、Shift+タップ、Shift+←→、Ctrl+A、小節メニューの「小節を範囲選択」
- 音符に項目を足すとき（連符・スラー・歌詞など）は、`cutEvent()` で分けたかけらに何を引き継ぐかを決める（今はすべて複製する）

## 今後のステップの差し込み口

### ステップ2：iPad鍵盤入力と再生（実装済み）
- `src/input/keyboard.ts` の `PianoKeyboard` が `#input-panel` に鍵盤を描き、押された MIDI 番号を返す。
  `main.ts` が `editor.inputMidi(midi, chord)` を呼ぶ（他の鍵を押さえたまま押したら chord=true）
- 再生は `src/audio/`。`buildSchedule()` が楽譜を秒単位の音の一覧にし（タイは1音にまとめる）、
  `Player` が少し先までを Web Audio で予約していく。音色はパートの `instrument`（`piano` / `synth`）

### ステップ3：五線への手書き入力（実装済み）
- `src/handwriting/pen.ts` の `PenLayer`：手書きモード（`Mode` の `'pen'`）の間だけ `#score` の上に canvas を重ね、
  線を集める。書き終えて 650ms 待つか、前の記号から右に離れて書き始めたら `onRecognize` に渡す。
  `pointerType` が `pen` ならいつも書く。`touch` は「指で書く」がオンのときだけ（安価なスタイラスは `touch` で届く）。
  2本指は書きかけを捨てて手動でスクロール、接触面の大きいもの（手のひら）は無視
- `src/handwriting/recognize.ts`：機械学習なしの図形判定。長さは五線の間隔を単位に比べる。
  `clusterStrokes()` で横に離れた線を別の記号に分け、`recognizeCluster()` が
  符幹（長い縦の線分）→ 頭（塗りつぶしか輪か）→ 旗・付点・臨時記号、の順に調べる。
  符幹がなければ全音符・黒丸・休符・臨時記号・点・消しゴムを調べる
- `src/handwriting/apply.ts`：読み取り結果を `Editor` の操作に変える（入力位置より右なら続けて入れる、
  既存の音符の真上・真下なら和音、点・臨時記号は近くの音符へ、消しゴムは `editor.eraseEvents()`）
- 精度を上げるときは `tests/handwriting.test.ts` に形を足してから `recognize.ts` のしきい値を変える。
  手ぶれ（乱数のずれ）を入れた試験もある

### ステップ4：PDF楽譜の取り込み（実装済み）
- 入口は `src/import/index.ts` の `importFile()`。中身を見て種類を判断する
  - MusicXML（.musicxml / .xml）→ `src/import/musicxml.ts` の `parseMusicXml()`。.mxl（zip）は `mxl.ts` で展開（fflate）
  - このアプリの PDF → 書き出し時に文書情報（Keywords）へ `MSE-SCORE1:` + base64 の楽譜JSONを入れてある（`embed.ts`）。それを取り出すだけ
  - ほかの PDF・写真 → `needs-omr` を返し、画面（`#dlg-import-help`）で Audiveris（パソコンの無料OMR）→ .mxl → 取り込み の手順を案内
- MusicXML → Score は「曲頭からのティック付きの音の並び」（`timeline.ts`）を作ってから小節に詰め直す。
  1段1声部、2段のパートは段ごとに別パート、拍子は最初のものだけ、連符は連符のまま取り込む（入れ子や7連符などティックが割り切れないものは32分音符の格子に丸める）。弱起は1小節目の後ろに寄せる
- 逆向き（Score → MusicXML）は `src/export/musicxml.ts`。MuseScore などへ持っていける
- ブラウザ内だけでの OMR（画像から直接読む）は未実装。やるなら `importBytes()` の `needs-omr` の所に差し込む

### 記号（スラー・強弱・アーティキュレーション）
- 音符1つに付く記号は `MusicEvent` の `articulations` / `dynamic`。複数の音符にまたがる記号（スラー・クレッシェンド・ディミヌエンド）は
  `Score.spanners`（始まりと終わりの音符の id）。音符が消えたスパナーは残っていても `resolveSpanners()` で無視する（`src/model/marks.ts`）
- 編集は `Editor.toggleArticulation()` / `setDynamic()` / `toggleSpanner()`。道具は `src/ui/marks-palette.ts` が `#palette` に足す
- 描画は `src/render/marks.ts`（アーティキュレーションは VexFlow、スラー・ヘアピンは自前の線、強弱記号は Bravura の字形。段をまたぐ記号は段の端で切る）
- 再生は `src/audio/expression.ts`（強さ・スタッカートの長さ・フェルマータの間）
- MusicXML は `src/export/musicxml-marks.ts` と `src/import/musicxml-marks.ts`
- 範囲コピーなどで音符を複製するときは、id を付け直すならスパナーも付け直すこと
- スラーなどは同じパートの同じ声部の音どうしをつなぐ（`flatEvents(score, part, voice)` の並びでたどる。声部をまたぐものは無効）。
  `ResolvedSpanner.voice` を持つ。2声部の小節では声部1のスラーは上、声部2は下に描く。再生のヘアピンは声部1のものだけ使う

### 連符
- 音符・休符の `tuplet?: { id, actual, normal }`（3連符なら 3:2）。同じ `id` が小節内で続いた音が1つの連符。
  `duration` は楽譜に書く音価のまま持ち、鳴る長さは `eventTicks()` が `normal/actual` 倍にする（`writtenTicks()` は縮めない長さ）
- 作れる種類は `TUPLET_NORMAL`（2:3, 3:2, 4:3, 5:4, 6:4）。4分音符=480 で長さが整数になるものだけ。7連符などは未対応
- `Editor.createTuplet(n)`：入力モードは今の音価の長さ、選択モードは選んだ音の長さで作る。カーソルが連符の中にある間の入力は
  `overwriteInTuplet()` で連符の中だけを上書きする（はみ出さない）。連符にかかる普通の上書きは `overwriteAt()` が連符ごと消す
- 描画は `render.ts` の `buildTuplets()`（VexFlow の `Tuplet`、Voice に入れる前に作る）と `tupletBeams()`

### 歌詞・コードネーム・文字・練習番号
- データ：音符・休符の `EventTexts`（`lyrics`（番ごと、末尾 `-` で次の音節とハイフン）・`chord`・`text`）と、
  いちばん上のパートの小節の `rehearsal`。どれも省略できるので `schemaVersion` は変えていない
- 共通処理は `src/model/texts.ts`（次の音符の探し方、コードネームの読み取りと ♯♭ 表示、練習番号の続き）
- 入力は `src/ui/text-entry.ts`。パレットに「歌詞・コード・文字・練習番号」を足し、楽譜の上端に入力欄を出す。
  歌詞はスペース／Enter で同じ声部の次の音符（休符とタイの続きはとばす）、`-` でハイフン。日本語の変換中のスペース・Enter は変換に使う。
  楽譜の文字をタップすると直せる（`main.ts` の pointerdown／up から `texts.pointerDown/Up` を呼ぶ）
- 描画は `src/render/texts.ts`。文字の幅のぶん見えない Annotation を音符に付けて間隔を空け、段ごとに高さをそろえて描く。
  歌詞・文字のあるパートは譜表の間を広げる（`partOffsets()`）。声部2の歌詞は、声部1の歌詞の行の下に続けて書く（`PartSpacing.voice1Verses`）
- PDF は日本語の標準フォントがないため、`renderPage()` の `textSink` で文字を集めて、1つずつ画像にして載せる
- MusicXML は `<lyric>`・`<harmony>`・`<words>`・`<rehearsal>` で読み書きする

## 2声部と移調

- 声部の切り替えは `editor.setVoice()`。カーソルは同じ拍の位置のまま移る。声部2の休符の途中は `setCursorAtTick()` が休符を分けて位置を作る
  （音は変わらないので元に戻すには残さない）。声部2の音符を選ぶと、入力も声部2になる
- 描画（`render.ts`）は声部2のある小節だけ、声部1の符尾を上・声部2を下にし、休符も上下に離す。臨時記号は声部をまたいで時間順に判定。
  `MeasureHit.voices[v]` に声部ごとの当たり判定（`tick` 付き）。`events` は声部1のまま
- 再生は両方の声部を鳴らす（再生位置の目印は声部1）。MusicXML は `<backup>` と `<voice>2</voice>` で書き出し、取り込みは段ごとに最初の2声部まで
- 範囲コピー・貼り付け、スラー、歌詞は声部2でも使える（上のそれぞれの節を参照）
- 手書き入力は今は声部1だけ
- 移調は `src/model/transpose.ts`。音程は `{ steps（白鍵の数）, semitones }` で、綴りまで正しく動かす。
  `editor.transpose(interval, scope)`：楽譜全体なら調号も変え（7つを超えたら異名同音の調）、譜表・音符だけなら臨時記号で書く。
  範囲選択を足すときは `editor.selectionIds()` を広げれば移調も対応する。画面は `src/ui/transpose.ts`（#dlg-transpose）
