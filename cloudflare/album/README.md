# 非公開アルバム用Worker

写真・動画本体を既存R2バケット `okayama-girls-media` に保存し、タイトル等だけを既存Firestore `album/{新しいUUID}` に追加します。既存写真、既存データ、Firestoreルールは変更しません。既存アプリのFirebase Authenticationでログインした管理者だけがアップロードでき、管理者・メンバーが閲覧できます。

2026年10月19日、ユーザーがWorker `white-leaf-338b` を作成してコードをデプロイしました。R2バインディング `MEDIA`、通常変数3件、暗号化Secret2件を設定し、`https://white-leaf-338b.4khrhp97z8.workers.dev/health` の `{"ready":true}` をユーザーの画面で確認しています。`index.html` の `ALBUM_API_BASE` はこのWorkerのHTTPS URLです。本番でのログイン・アップロード・閲覧は未検証です。

## 最初に行う操作

既存Worker `white-leaf-338b` を更新します。新しいWorker、サイト、R2バケットを作り直す必要はありません。以下は設定を再確認するときの手順です。

## 設定する内容

1. Workerのコードを `worker.mjs` にします。外部ライブラリは不要です。
2. R2バインディング名 `MEDIA` を、既存バケット `okayama-girls-media` に接続します。バケットの公開設定は無効のまま維持します。R2用のアクセスキーを発行する必要はありません。
3. 通常の変数を `wrangler.jsonc` の `vars` と同じ値にします。FirebaseのWeb APIキーは既存アプリと同じ公開設定値です。
4. Firebaseプロジェクト `okayama-girls` の専用サービスアカウント `album-media-worker@okayama-girls.iam.gserviceaccount.com` を使います。`metadata-writer-role.json` の作成・取得権限2件だけを持つカスタムIAMロール `albumMetadataCreator` を割り当てたことを画面で確認済みです。このIAMロール自体はコレクション単位の制限ではなく、Workerの固定された `album` パスと新規作成APIで書き込み先を制限します。既存アカウントやFirestoreセキュリティルールは変更しません。EditorやOwnerを付与しないでください。
5. サービスアカウントのJSON鍵全体を、Workerの**暗号化されたSecret** `FIREBASE_SERVICE_ACCOUNT` に直接保存します。秘密鍵・JSON鍵をチャットへ貼ったり、GitHubやHTMLへ保存したりしないでください。
6. 32文字以上の十分にランダムな値を、Secret `MEDIA_SIGNING_KEY` に保存します。これも公開しません。
7. Workerをデプロイし、実URLと設定を確認した後で `ALBUM_API_BASE` を設定します。Firebaseのブラウザ用APIキーに参照元制限がある場合は、既存設定を緩和せず、サーバー用のAPIキー等を別途検討してください。

JSON鍵の作成とSecretへの登録はユーザーがPCとCloudflare画面で実施済みと報告しています。秘密情報はチャット、リポジトリ、公開HTMLに受け取っていません。Secret値を読み出して確認する運用はしません。

CLIを利用できる担当者はこのフォルダで `npx wrangler deploy`、Secret投入は `npx wrangler secret put FIREBASE_SERVICE_ACCOUNT` と `npx wrangler secret put MEDIA_SIGNING_KEY` を使えます。実行には別途Cloudflareへの認証が必要です。CloudflareアカウントIDや認証情報はこのリポジトリに含めません。

## 動作とデータ保護

- ブラウザはFirebase IDトークンをAuthorizationヘッダーでWorkerへ送ります。WorkerはGoogleの `accounts:lookup` で有効性を確認し、そのユーザーのトークンでFirestore `users/{uid}` を取得してroleを確認します。ブラウザから渡されたroleやUIDを信用しません。
- アップロードは管理者のみ。8MiBずつ分割し、写真25MiB・動画2GiBまで受け付けます。ファイル形式・先頭シグネチャ・各チャンクの長さ・完了時のサイズをサーバーでも検証します。画像の再生成・再圧縮はしません。
- メディアは `album-media/{UUID}`、一時アップロード情報は `album-pending/{UUID}.json` だけを利用します。任意のR2キーをブラウザから指定することはできません。
- メタデータ登録はサービスアカウントでFirestore REST APIの新規作成だけを使います。同じUUIDの既存文書を上書きせず、通信失敗からの再試行時は対応する保存情報を確認します。他のコレクションへの書き込みは実装していません。
- 新規メタデータには `title`、`createdAt`（ミリ秒の整数）、`source: r2`、`objectKey`、`mediaType`、`mimeType`、`size`、`originalFilename`、`uploadedBy` を保存します。バイナリ本体や恒久的な公開URLは保存しません。
- メタデータ登録に失敗しても、アップロード済み本体を消さずに完了処理を再試行できます。途中まで保存できた複数ファイルを再試行しても、その画面内では成功済みファイルを重複送信しません。
- 「中止」で削除するのは、そのユーザーが今回開始した未完了アップロードの一時情報だけです。完了済み写真・動画・既存Firestore文書を削除する機能は実装していません。
- メンバーの閲覧時には、WorkerがFirestoreの既存ルールで文書の閲覧権限を確認し、対象ファイル専用・15分の署名付き閲覧URLを発行します。このURL自体は有効期限内の閲覧権限を持つため共有しない運用です。Firebase IDトークンやR2秘密鍵をURLに含めません。
- 動画のRange取得に対応し、閲覧URLが切れた際には再取得します。HEICやMOV等の再生可否は端末の対応コーデックにも依存し、対応していない場合は案内を表示します。変換処理は追加していません。
- 既存Firestoreの `url: data:image/...` を持つ写真は読み取り専用で表示し、移動・削除・上書きしません。
- R2の未完了multipartは既定で7日後に破棄されます。一時JSONは小容量ですが残るため、`album-pending/` だけを対象とする有効期限ルールを設定するかは別途確認します。既存オブジェクト全体に適用するライフサイクルルールは作成しません。
- 写真等の閲覧中やアップロード中は、既存の自動更新保護を使って画面再読み込みを待たせます。下部キャラクター・ホーム画面・LIVE本体は変更しません。

`/health` は必要な変数・バインディングが設定されているかの簡易確認で、Google/R2への実アクセス権限を保証するものではありません。公開後の初回確認では管理者が新しい写真を1件アップロードし、メンバーとして閲覧できることを確認します。既存データを検証のために削除・上書きしません。プラン変更や有料プランへの加入は自動では行いません。

## ローカル検証

Node.js 24で、リポジトリのルートから以下を実行します。

```sh
node --test --test-isolation=none cloudflare/album/worker.test.mjs
node --test --test-isolation=none cloudflare/album/client.test.mjs
```

テストではFirebase・R2をメモリ上の模擬データへ置き換え、実ネットワーク・実鍵・本番データを利用しません。本番ログインや本番への試験アップロードを実施済みとは扱いません。

参照仕様：

- [Firebase Authentication REST API](https://firebase.google.com/docs/reference/rest/auth)
- [Firestore REST APIの認証と権限](https://firebase.google.com/docs/firestore/use-rest-api)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 multipart API](https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/)
