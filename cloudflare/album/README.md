## v9.79：入金枠の削除・状態タップ

既存Workerのコードを、このフォルダの `worker.mjs` 全文へ再度更新してデプロイします。鍵・バインディング・環境変数・IAM・Firestoreルールの変更はありません。`/health?check=979` の `features.feeLedgerEditing: true` で新コードの反映を確認できます。この表示は本番認証・R2への入金保存試験を実施した意味ではありません。公開の `copy-worker.html?v=9.79` は最新版の全文を読み込みます。

- `POST /fees/{UUID}/member-state` は、対象選手・変更後の状態・日付・操作UUID・台帳の版番号を受け取ります。「入金済み」は残額だけを本日付・方法「その他」・状態変更メモ付きで追加します。「未入金」はその選手の有効な入金をすべて取り消し、元の金額・日付と取消者・時刻・理由を保持します。1回のR2条件付き更新で反映するため、分割入金の一部だけが取り消された状態にはなりません。
- `DELETE /fees/{UUID}` は版番号を確認し、削除日時・削除者を保存します。削除した枠を一覧と集計から除外し、履歴は非公開R2へ保持します。R2オブジェクトの物理削除ではありません。既存の入金・作成リクエストが再送されても削除済み枠を復活させません。
- 両APIとも既存の管理者認証を必須とします。状態の再送は操作UUIDで照合し、後の状態を反転させたり、二重入金を登録したりしません。閉じた受付の状態ボタンは無効で、再開してから操作します。
- 既存の台帳に新しい項目を一括追加しません。編集した枠だけに状態変更履歴を保存します。状態変更は1枠500操作まで、入金記録の既存上限は500件です。旧Workerの場合も従来の台帳は閲覧できますが、新しい削除・状態操作は無効になり、更新案内を表示します。

模擬データのテストでは削除、分割入金、再送、同時更新、権限を確認しています。本番台帳への試験入金・削除は行っていません。

---

## v9.78：管理者専用の入金台帳

サイト側の追加に合わせ、既存の `white-leaf-338b` のコードを、このフォルダの `worker.mjs` 全文へ更新します。既存のMEDIAバインディング・Secret・環境変数を維持してデプロイしてください。新しい鍵の作成、IAM権限追加、Firestoreルール変更、バケット公開は不要です。CodexからCloudflareへデプロイできる接続はないため、この更新は管理画面で行います。

1. CloudflareのWorkers & Pages → white-leaf-338b → コードを編集、を開きます。
2. 既存コードを `worker.mjs` の全文で差し替え、デプロイします。既存のアルバムAPIも含んだ単一ファイルです。
3. `/health` に `features.feeLedger: true` が表示されることを確認します。この表示だけではGoogle認証・R2への実アクセスは検証できません。
4. 管理者でサイトを開き、ホーム → 入金管理から利用します。未更新なら画面にWorker更新の案内が表示され、ブラウザだけの台帳へ切り替えたりはしません。

台帳は非公開R2の `fee-ledgers/{UUID}.json` だけを使います。既存の `album-media/` と `album-pending/` へ入金処理が書き込むことはありません。APIは `/fees` と `/fees/{UUID}/payments|voids|status` で、GETも含めGoogleによるIDトークン確認と既存usersのadmin確認を必須にします。メンバー・匿名には台帳を返しません。既存のメディア閲覧チケットから台帳のキーを指定することもできません。

請求は選手名をサーバー側で取得し、1請求最大100人、1人1〜10,000,000円、入金記録は取消分を含め500件までです。受付終了後も未入金額と履歴は残ります。入金は未入金額以下の整数で登録し、取り消す場合は理由と操作日時・操作ユーザーを保存します。物理削除は実装しません。同一リクエストの再送による二重登録を防止し、R2のETag条件付き書き込みと台帳の版番号で、同時操作が他の入金を上書きしないようにします。

既存のR2の非公開設定を維持してください。R2オブジェクトを管理画面から直接編集・削除する運用は、このアプリの履歴・競合制御を通りません。既存全体を対象にしたライフサイクルの変更は行っていません。

ローカル検証：`node --test --test-isolation=none cloudflare/album/fees.test.mjs`。Firebase、R2、通信は模擬データです。本番台帳への試験登録・実機での入金操作は行っていません。

---

# 非公開アルバム用Worker

## v9.73：写真・動画とフォルダの削除（2026年10月25日）

管理者だけが写真・動画一覧とフォルダ内の各写真にある「削除」、フォルダ一覧の「削除」を利用できます。サーバーでroleを再確認し、対象名・削除方法を確認する画面で実行するまで削除要求を送りません。確認時に取得した更新バージョンをサーバーで照合し、その後に編集された別の状態をそのまま消さないようにします。

フォルダの削除は、ユーザーが選択したとおり中の写真・動画を通常タブへ戻し、フォルダだけを削除します。24件ずつ所属先を更新し、処理中のフォルダには新規保存・移動をさせません。削除途中で通信が切れた場合は管理者の「途中の削除処理」から再開できます。保存先フォルダが消えた時点ですでにアップロード中だった新規ファイルは、通常タブへ保存して保持します。削除済みのフォルダIDを参照する項目が残った場合も、通常タブに表示して見失わないようにします。

写真・動画そのものの削除は別操作です。Firestore文書からURL・画像データ・ファイル参照などをフィールドマスクで消し、削除済みの最小限の記録を残して再実行による復活を防ぎます。R2ではFirestoreの固定キー `album-media/{当該UUID}` とR2メタデータのalbumIdが一致する場合だけ本体を削除します。HTML内の共通画像や、別写真・別フォルダには触れません。旧Base64写真はFirestoreの画像データを消します。外部HTTPS URLの写真はアルバムの参照を削除し、管理外の外部サイトを変更することはありません。

R2の削除に失敗しても成功扱いにせず、管理者に未完了を表示します。再試行用の記録を使い、対象を変えずに続きを実行できます。写真本体の削除後は元に戻せません。フォルダ削除では写真本体を削除しません。

**Google Cloudのロール追加・鍵の再発行・Firestoreルールの変更は不要です。** 現在の4つのIAM権限を維持し、更新権限とR2バインディングで処理します。新機能の利用には既存Cloudflare Workerのコードを本版に更新します。[スマホ用コピー画面](copy-worker.html)からコード全体をコピーできます。`/health` に `mediaDeletion:true` と `folderDeletion:true` が出る版です。旧Workerのままでは編集機能を維持し、削除ボタンだけを無効にしてサーバー更新待ちを表示します。

削除を含むローカルテスト36件は模擬データだけで確認します。検証目的で本番の写真・動画・フォルダを削除しません。Workerのv9.73反映と本番の削除操作はまだ未確認です。

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
- アップロード中の「中止」で破棄するのは、そのユーザーが今回開始した未完了アップロードの一時情報だけです。v9.73の管理者用「削除」は別操作として、上記の確認画面から実行します。
- メンバーの閲覧時には、WorkerがFirestoreの既存ルールで文書の閲覧権限を確認し、対象ファイル専用・15分の署名付き閲覧URLを発行します。このURL自体は有効期限内の閲覧権限を持つため共有しない運用です。Firebase IDトークンやR2秘密鍵をURLに含めません。
- 動画のRange取得に対応し、閲覧URLが切れた際には再取得します。HEICやMOV等の再生可否は端末の対応コーデックにも依存し、対応していない場合は案内を表示します。変換処理は追加していません。
- 既存Firestoreの `url: data:image/...` を持つ写真も表示します。通常のタイトル・所属先変更では写真のURL・画像データを保持します。v9.73で明示的に確認した写真の削除時だけ、その写真の画像データを取り除きます。
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


## 地図・場所（v9.82導入／v9.83権限変更）

地図機能は既存Workerの全文更新が必要です。コピー画面から既存のアルバム・入金処理を含むworker.mjs全体を置き換えます。新しいSecret、バケット、IAM権限、Firestoreコレクション／ルール変更は不要です。既存R2バインディングMEDIA内のmap-places/とmap-place-photos/を使用します。

- GET /places（50件ずつ・カーソル対応）、GET /places/{UUID}、GET /places/{UUID}/photoは管理者／メンバー認証が必須。
- PUT /places/{UUID}、DELETE /places/{UUID}は毎回管理者／メンバー認証が必須（v9.83で全員へ開放）。写真はJPEG/PNG/WebP、5MBまで。
- version・ETag・operationIdで競合と重複書込を防止。削除済み記録で復活を防止し、旧写真の削除失敗は同じ操作で再試行可能。
- health?check=983のfeatures.mapPlaces:true、mapPlacesSharedEditing:trueと既存6フラグを確認。本番操作の結合確認とは区別する。

詳細は[地図v9.82](../../tests/地図-v9.82.md)を参照してください。


## スマートフォンから設定するGitHub連携公開（2026-10-30）

iPhoneのコードエディタでペーストが利用できない場合は、既存WorkerのSettings → Builds → ConnectでGitHubに接続します。ユーザーから接続設定を完了した旨の連絡を受けています。新しいWorkerは作成しません。ビルドと公開が成功したかは、設定完了とは別に確認します。

今回案内した設定:

- Worker: white-leaf-338b（既存）
- GitHub: ossy7895/okayama-girls、main
- ビルドコマンド: 空欄
- デプロイコマンド: `npx wrangler deploy --config cloudflare/album/wrangler.jsonc`
- プレビュービルド: 無効

デプロイコマンドがリポジトリルートから既存設定ファイルを指定するため、ルートディレクトリ欄の入力は不要です。設定ファイルのname・main・MEDIAバインディング・通常変数は現行のものを使用します。既存WorkerのSecretをチャットやGitHubへ転記せず、ビルド用の変数へ複製しません。

接続後にmainへPushするとCloudflareのビルドが開始します。GitHub側のチェック、Cloudflareのビルド結果、healthのmapPlaces/mapPlacesSharedEditingと既存6フラグを確認します。GitHub Pagesの成功だけでWorkerも公開済みとは報告しません。本番の登録・編集・削除を伴う試験は行いません。

以後もWorker公開はその回に依頼された変更の範囲で実施します。連携権限や料金プランを独断で拡張しません。


### リポジトリルートからの公開対象の明示

2026-10-30、最初のWorkers Builds成功後、APIのルートURLがサイト本体のindex.htmlとバイト単位で一致し、/healthが空の404応答を返す状態を確認しました。ビルド成功だけではAPIコードの公開を証明できません。

そのため、リポジトリルートにもwrangler.jsoncを配置し、mainをcloudflare/album/worker.mjsへ明示しました。ルートから通常の`npx wrangler deploy`が実行された場合も、サイト本体の自動検出を避けて既存WorkerのAPIを公開します。明示的な`--config cloudflare/album/wrangler.jsonc`を指定する既存コマンドも引き続き利用できます。

両設定はmainの相対パス以外を一致させます。Worker名・互換日・workers.dev・MEDIAバインディング・通常変数は変更せず、Secretは設定ファイルに含めません。独立したフレームワークやビルド用package.jsonは導入しません。公開後は/healthがJSONで返ることと全8フラグを確認します。


### 設定不足の読み取り専用診断

API公開後に設定不足で503となる場合、/healthはready:falseとmissingConfiguration（不足するバインディング・変数・Secretの名前だけ）を返します。Secretの値やJSONの内容は返しません。通常のAPIは従来どおり設定不足を拒否します。名前の一覧を使って既存の設定を確認し、秘密情報の送付・読み出しや、原因未確認の鍵の再作成は行いません。


### 設定の保持と必須Secretの検査

2026-10-30の管理画面では通常変数3件だけが表示され、実際の/healthもFIREBASE_SERVICE_ACCOUNTとMEDIA_SIGNING_KEYの不足を報告しました。現時点で過去の設定の型や消失原因は断定していません。

両方のWrangler設定にkeep_vars:trueを指定して、管理画面に追加した通常変数をコードの公開時に意図せず除去しないようにします。暗号化Secretの保持とkeep_varsは別の仕組みです。さらにsecrets.requiredに上記2つの名前だけを宣言し、不足したままコード公開が成功扱いになることを防ぎます。値は設定ファイルに含めません。復旧が終わるまで、GitHub連携ビルドが不足Secretを理由に失敗する場合があります。

値をユーザーの手元で保管している場合は、既存Workerのプロダクションの「変数を追加する」でタイプSecretを選び、元の名前・元の値をCloudflareへ直接設定してデプロイします。値やJSON本文をチャットやリポジトリへ転記しません。保管状況が不明な場合は、鍵の再発行や過去版への切替を独断で行わず、復旧方法を確認します。


## 現在公開中の版の設定を引き継ぐ公開（復旧用・2026-10-30）

ユーザー承認の一時切替後、c6e58d7bの公開healthはHTTP 200・ready:trueと既存6フラグを返しました。ただし、その後の通常の再公開はビルド段階で失敗しています。Cloudflare公式仕様では、通常のスクリプトアップロードが参照するのは最終アップロード版であり、現在公開中の版とは限りません。

この場合は、Workers Buildsのデプロイコマンドを次へ変更します。

```
node cloudflare/album/deploy-worker.mjs
```

この公開用スクリプトはNode.jsの標準機能だけを使い、既存のWorkers Buildsが渡すCLOUDFLARE_API_TOKENを通常のAPI認証として利用します。値の表示・外部送信先への転送・秘密ファイルの探索は行いません。追加のサービスやpackage.jsonは導入しません。

- 既存APIの読み取り専用healthでreadyと既存6機能を事前確認します。
- 公開中のデプロイIDだけを取得します。Secretや通常変数の値を取得するAPIは呼びません。単一版が100%公開されていることと、確認中に切り替わっていないことを検査します。
- 既存6バインディングすべてを、公開中のversion_idを明示したinheritとしてCloudflare内で引き継ぎます。新しい値や鍵は作成・送信しません。
- 公式Workers APIのPOST /accounts/{account_id}/workers/workers/{worker_id}/versions?deploy=trueへ、既存のworker.mjs全文、defaultだけを再公開するworker-entry.mjs、バインディングの名前・引継ぎ元版番号を送ります。静的アセットは含めません。
- 対象は既存white-leaf-338bだけです。コードの互換日は従来の2026-10-19を使います。ドメイン・公開URL・Firebase認証方式・Firestoreルール・R2データは変更しません。
- 公開後は地図と全員編集を含む全8フラグを再確認します。失敗時は他の担当者が版を変えていない場合だけ直前の公開版へ切り戻します。ユーザーの一時復旧承認の範囲内で行います。
- ログには公開版番号と確認結果だけを出します。Cloudflare APIの生の応答・入力コード・トークン・Secret値は出力しません。

通常のWrangler公開へ戻す場合も、最終アップロード版の設定が揃っているかを先に確認します。設定が戻ったという理由だけで必須設定の検査を外して再公開しません。

2026-10-31の修正: 最初の継承公開はHTTP 400・code 10021で失敗しました。worker.mjsを直接入口にすると、テスト用の数値exportをWorkerの入口として解釈し、`Incorrect type for map entry 'MAX_IMAGE_BYTES'`となることをworkerd 2026-10-30で再現しました。worker-entry.mjsは同じdefaultハンドラーだけを再公開し、元の定数・補助関数は内部モジュールに保持します。Worker本体・認証・バインディング値は変更しません。rootとこのフォルダのWrangler入口も合わせています。

模擬テスト: `node --test --test-isolation=none cloudflare/album/deploy-worker.test.mjs`（13件通過）。workerdで修正後の実モジュール起動と、秘密情報未設定のローカルhealth応答を確認しました。本番データの試験変更を伴う検証は行っていません。これらの検証だけでは本番公開成功を意味しません。

公式仕様:
- https://developers.cloudflare.com/workers/observability/errors/#inherit-binding-errors-10057
- https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/create/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
