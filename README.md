# ScanSnap → Discord / LINE Notifier (GAS + clasp)

Google Drive の特定フォルダ（例: ScanSnap の保存先）に新規ファイルが追加されたら、Discord のチャンネルへ Webhook 通知、および LINE Messaging API で push 通知する Google Apps Script プロジェクトです。clasp を用いてローカルから管理・デプロイします。Discord / LINE はそれぞれ個別に有効化でき、両方同時にも送信可能です。

## 特長 / 動作概要

- 新規ファイルのみ通知: 初回にベースラインを現在時刻へ設定し、既存ファイルは通知しません。
- 5 分間隔で監視: 時間主導トリガーを 5 分おきに実行し新規を検出します。
- Discord へ簡潔に投稿: ファイル名、作成時刻（JST）、webViewLink を送信します。
- LINE へも通知: ファイル名、作成日時、サイズ、リンクをプレーンテキストで送信します。
- Discord / LINE 個別有効化: どちらか一方、または両方を同時に利用可能です。
- 冪等性担保: 直近の処理済みファイル ID を最大 200 件まで保持します。

## フォルダ構成

- `src/Code.gs`: 本体スクリプト
- `src/appsscript.json`: マニフェスト（Advanced Drive v3 / OAuth スコープ）
- `.clasp.example.json`: clasp 用サンプル設定（`.clasp.json` は Git で無視）

## 事前準備

1. Discord で任意チャンネルの Webhook URL を作成して控える（Discord を使う場合）。
2. LINE Messaging API のチャネルアクセストークンと送信先 ID を用意する（LINE を使う場合）。詳細は後述の「LINE Messaging API のセットアップ」を参照。
3. 監視対象の Google Drive フォルダ ID を確認する（URL の `folders/<ID>` の部分）。
4. Node.js と `@google/clasp` をインストールしておく。

## clasp 初期設定

1. ログイン
   - `clasp login`
2. `.clasp.json` の用意（このリポジトリでは Git 管理外）
   - PowerShell 例: `Copy-Item .clasp.example.json .clasp.json`
   - `.clasp.json` の `scriptId` を自身のスクリプト ID に置き換える
   - まだスクリプトを持っていない場合は新規作成:
     `clasp create --type standalone --title "ScanSnap Discord Notifier" --rootDir ./src`
3. コードとマニフェストを push
   - `clasp push`
4. スクリプトエディタを開く（確認用）
   - `clasp open`

## GAS 側の設定

1. スクリプト プロパティを設定
   - `FOLDER_ID`: 監視対象のフォルダ ID（必須）
   - `DISCORD_WEBHOOK_URL`: Discord の Webhook URL（Discord を使う場合）
   - `LINE_CHANNEL_ACCESS_TOKEN`: LINE Messaging API のチャネルアクセストークン（LINE を使う場合）
   - `LINE_TARGET_ID`: LINE の送信先 ID（ユーザー/グループ/トークルーム）（LINE を使う場合）
   - 設定は Apps Script エディタの「プロジェクトの設定」→「スクリプト プロパティ」で追加
   - 通知先の有効条件:
     - Discord: `DISCORD_WEBHOOK_URL` が設定されていれば送信
     - LINE: `LINE_CHANNEL_ACCESS_TOKEN` と `LINE_TARGET_ID` が両方設定されていれば送信
     - どちらも未設定の場合は `setConfig()` でエラーになります。少なくとも一方は設定してください。
2. 初期化を実行
   - エディタの関数選択で `setConfig` を選び「実行」
   - 初回実行でベースライン（現在時刻）を保存し、5 分間隔のトリガーをセットします
3. 動作確認
   - 必要に応じて `checkForNewFiles` を手動実行し、エラーがないか確認

## 仕組み（主要関数）

- `setConfig()`: スクリプト プロパティの検証、ベースライン保存、トリガー登録
- `installTrigger()`: `checkForNewFiles` を 5 分間隔で実行するトリガーを 1 つだけ維持
- `checkForNewFiles()`: 前回以降に作成された新規ファイルを Drive v3 で列挙し Discord / LINE へ通知
- `postToDiscord()`: Discord Webhook へ embed 投稿（429 リトライ付き）
- `postToLine()`: LINE Messaging API へ push 送信（429 リトライ付き、1回あたり最大5件）

## 必要な権限 / スコープ

- Drive メタデータ読み取り: `https://www.googleapis.com/auth/drive.metadata.readonly`
- 外部リクエスト（Discord Webhook / LINE Messaging API）: `https://www.googleapis.com/auth/script.external_request`
- スクリプト プロパティ / トリガ: `https://www.googleapis.com/auth/script.scriptapp`

これらは `src/appsscript.json` に定義済みです。Advanced Service として Drive v3 を有効化しています。LINE も Discord と同じ `script.external_request` スコープを利用するため、追加のスコープ定義は不要です。

## LINE Messaging API のセットアップ

> **注意**: 旧来の LINE Notify は 2025/3 に廃止されたため、本プロジェクトでは LINE Messaging API（公式アカウント経由の push メッセージ）を使用します。

1. [LINE Developers](https://developers.line.biz/) でプロバイダーと Messaging API チャネルを作成
2. チャネルの「Messaging API 設定」で「チャネルアクセストークン」を発行し、控える
3. 通知を受け取りたい LINE アカウント（自分自身や家族グループ）を公式アカウントと友だち追加
4. 送信先 ID を確認:
   - 個別ユーザー: 公式アカウントにメッセージを送って webhook で取得する `userId` など
   - グループ / トークルーム: 公式アカウントをグループに招待した後に同ページの「グループ / トークルーム ID」を参照
5. Apps Script のスクリプト プロパティに `LINE_CHANNEL_ACCESS_TOKEN` と `LINE_TARGET_ID` を追加

### LINE の注意点

- 無料枠（Light Plan）では月 1,000 メッセージまで。超過分は従量課金または送信制限されるため、通知頻度に注意
- `push` API は友だち追加済みの相手にのみ届く。未追加ユーザーへの送信は失敗する
- グループ / トークルームへ送る場合は公式アカウントをその部屋に招待しておく
- アクセストークンは定期的にローテーション推奨（漏洩時は即時再発行）

## 運用メモ

- 初回 `setConfig()` 実行までは通知されません。
- 通知リンクは `webViewLink` です。対象ファイルの共有権限により閲覧可否が決まります。
- フォルダ名の重複を避け、必ず「フォルダ ID」で監視対象を指定してください。

## トラブルシュート

- Discord に投稿されない: Webhook URL、権限付与、`FOLDER_ID` の設定を再確認。
- LINE に通知されない: `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_TARGET_ID` の設定、公式アカウントの友だち追加状態を再確認。実行ログに `LINE への通知に失敗しました` が出ていないか確認。
- LINE 401 Unauthorized: チャネルアクセストークンが不正または期限切れ。再発行してスクリプト プロパティを更新。
- LINE 400 Bad Request: `LINE_TARGET_ID` が不正、または公式アカウントと友だち追加されていない。ID の種類（ユーザー / グループ / トークルーム）を確認。
- LINE で届かない（エラーなし）: 無料枠の月 1,000 メッセージ上限に達していないか確認。
- 既存ファイルまで通知された: `setConfig()` を再実行して `LAST_CHECK` を現在時刻に更新。
- 通知頻度を上げたい: `installTrigger()` の間隔はコード上で `everyMinutes(5)` を変更可能（実行上限に注意）。
