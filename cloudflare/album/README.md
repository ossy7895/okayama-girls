# 非公開アルバム用Worker

写真・動画本体を既存R2バケット `okayama-girls-media` に保存し、タイトル等をFirestore `album/{新しいUUID}` に追加します。管理者は承認されたタイトル・保存先の変更ができ、管理者・メンバーが閲覧できます。既存写真・動画本体、承認済み画像、Firestoreルールは維持します。

## v9.72：タイトル編集とフォルダ（2026年10月24日）

「写真・動画」タブには `folderId` が空または未設定の項目だけを表示し、フォルダ内の項目はそのフォルダだけで表示します。過去の写真を分類のために一括移行・初期化しません。管理者はタイトル変更、フォルダの作成・名前変更、単体・複数選択でのフォルダ間移動と「写真・動画」への戻しができます。メンバーは閲覧のみです。

フォルダは新しい `albumFolders/{UUID}` に保存し、ブラウザから直接読み書きしません。認証・roleを検証するWorkerだけがアクセスします。写真の `title` と `folderId` はフィールドマスク付きREST APIで更新し、`url`、`objectKey`、画像・動画本体、`createdAt` を書き換えません。専用アカウントには更新・一覧権限を追加する必要がありますが、Firestoreセキュリティルールの変更や削除権限は不要です。

### 利用開始に必要な管理画面の操作

1. Google Cloud → IAMと管理 → ロール → `albumMetadataCreator`（表示名 `OKAYAMA Girls album metadata creator`）を編集し、既存の `datastore.entities.create` と `datastore.entities.get` を保持したまま、`datastore.entities.update` と `datastore.entities.list` を追加して保存します。サービスアカウントやJSON鍵を作り直す必要はありません。
2. Cloudflareの既存Worker `white-leaf-338b` の「コードを編集する」で、本フォルダの `worker.mjs` 全体に置き換えてデプロイします。既存R2バインディング、通常変数、暗号化Secretを保持します。
3. `/health` の `features.albumFolders` と `features.metadataEditing` が `true` になったことを確認します。これは権限の実アクセス確認ではありません。サイトのアルバムを再読み込みし、フォルダ一覧が読み込めるかを確認します。

上記2サービスをこのチャットから更新する接続・資格情報はありません。v9.72の画面は旧Workerでも既存写真の閲覧・アップロードを維持し、編集とフォルダ機能についてサーバー更新待ちを表示します。Google Cloudの権限が不足した場合も、対応する案内を表示します。設定完了と本番ログイン後の移動・編集は、まだ検証済みと扱いません。

ローカルの権限・メディア保護・分類・移動のテスト25件は通過しています。ブラウザによる実画面の追加検証は実行環境の制限で未実行です。公開後は既存データの削除や一括更新を行わず、利用者の意図する写真で個別に確認します。

2026年10月19日、ユーザーがWorker `white-leaf-338b` を作成してコードをデプロイしました。R2バインディング `MEDIA`、通常変数3件、暗号化Secret2件を設定し、`https://white-leaf-338b.4khrhp97z8.workers.dev/health` の `{"ready":true}` をユーザーの画面で確認しています。`index.html` の `ALBUM_API_BASE` はこのWorkerのHTTPS URLです。本番でのログイン・アップロード・閲覧は未検証です。

## 最初に行う操作

既存Worker `white-leaf-338b` を更新します。新しいWorker、サイト、R2バケットを作り直す必要はありません。以下は設定を再確認するときの手順です。

## 設定する内容

1. Workerのコードを `worker.mjs` にします。外部ライブラリは不要です。
2. R2バインディング名 `MEDIA` を、既存バケット `okayama-girls-media` に接続します。バケットの公開設定は無効のまま維持します。R2用のアクセスキーを発行する必要はありません。
3. 通常の変数を `wrangler.jsonc` の `vars` と同じ値にします。FirebaseのWeb APIキーは既存アプリと同じ公開設定値です。
4. Firebaseプロジェクト `okayama-girls` の専用サービスアカウント `album-media-worker@okayama-girls.iam.gserviceaccount.com` を使います。初回は作成・取得の2権限を割り当てました。v9.72では上記の手順で更新・一覧の2権限を追加し、`metadata-writer-role.json` と同じ4権限にします。このIAMロール自体はコレクション単位の制限ではありません。Workerの固定パス `album`・`albumFolders` とフィールドマスクで編集対象を制限します。EditorやOwnerを付与しないでください。
5. サービスアカウントのJSON鍵全体を、Workerの**暗号化されたSecret** `FIREBASE_SERVICE_ACCOUNT` に直接保存します。秘密鍵・JSON鍵をチャットへ貼ったり、GitHubやHTMLへ保存したりしないでください。
6. 32文字以上の十分にランダムな値を、Secret `MEDIA_SIGNING_KEY` に保存します。これも公開しません。
7. Workerをデプロイし、実URLと設定を確認した後で `ALBUM_API_BASE` を設定します。Firebaseのブラウザ用APIキーに参照元制限がある場合は、既存設定を緩和せず、サーバー用のAPIキー等を別途検討してください。

JSON鍵の作成とSecretへの登録はユーザーがPCとCloudflare画面で実施済みと報告しています。秘密情報はチャット、リポジトリ、公開HTMLに受け取っていません。Secret値を読み出して確認する運用はしません。

CLIを利用できる担当者はこのフォルダで `npx wrangler deploy`、Secret投入は `npx wrangler secret put FIREBASE_SERVICE_ACCOUNT` と `npx wrangler secret put MEDIA_SIGNING_KEY` を使えます。実行には別途Cloudflareへの認証が必要です。CloudflareアカウントIDや認証情報はこのリポジトリに含めません。

## 動作とデータ保護

- ブラウザはFirebase IDトークンをAuthorizationヘッダーでWorkerへ送ります。WorkerはGoogleの `accounts:lookup` で有効性を確認し、そのユーザーのトークンでFirestore `users/{uid}` を取得してroleを確認します。ブラウザから渡されたroleやUIDを信用しません。
- アップロードは管理者のみ。8MiBずつ分割し、写真25MiB・動画2GiBまで受け付けます。ファイル形式・先頭シグネチャ・各チャンクの長さ・完了時のサイズをサーバーでも検証します。画像の再生成・再圧縮はしません。
- メディアは `album-media/{UUID}`、一時アップロード情報は `album-pending/{UUID}.json` だけを利用します。任意のR2キーをブラウザから指定することはできません。
- メタデータの新規登録はFirestore REST APIの新規作成を使います。同じUUIDの既存文書を上書きせず、通信失敗からの再試行時は対応する保存情報を確認します。既存項目のタイトル・所属先の編集は、許可した項目だけを更新するフィールドマスクと更新日時の前提条件を使います。複数選択の移動は24件ごとのアトミックなcommitで処理し、途中のバッチで失敗した場合は成功済み分を示し、残りだけを再試行できます。
- 新規メタデータには `title`、`createdAt`（ミリ秒の整数）、`source: r2`、`objectKey`、`mediaType`、`mimeType`、`size`、`originalFilename`、`uploadedBy` を保存します。バイナリ本体や恒久的な公開URLは保存しません。
- メタデータ登録に失敗しても、アップロード済み本体を消さずに完了処理を再試行できます。途中まで保存できた複数ファイルを再試行しても、その画面内では成功済みファイルを重複送信しません。
- 「中止」で削除するのは、そのユーザーが今回開始した未完了アップロードの一時情報だけです。完了済み写真・動画・既存Firestore文書を削除する機能は実装していません。
- メンバーの閲覧時には、WorkerがFirestoreの既存ルールで文書の閲覧権限を確認し、対象ファイル専用・15分の署名付き閲覧URLを発行します。このURL自体は有効期限内の閲覧権限を持つため共有しない運用です。Firebase IDトークンやR2秘密鍵をURLに含めません。
- 動画のRange取得に対応し、閲覧URLが切れた際には再取得します。HEICやMOV等の再生可否は端末の対応コーデックにも依存し、対応していない場合は案内を表示します。変換処理は追加していません。
- 既存Firestoreの `url: data:image/...` を持つ写真も表示します。承認済みのタイトル・所属先変更に対応しますが、写真のURL・画像データは保持し、写真本体の移動・削除・上書きは行いません。
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
