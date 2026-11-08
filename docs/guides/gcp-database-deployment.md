# GCP DB・認証モードの通常配信

この経路は、初回移行・復元検証・固定revisionの切替を終えたサービスの通常配信用です。
Cloud SQL / Identity Platform の初期化や、Supabaseからの初回切替を自動実行しません。

## モードの境界

通常workflowは `GCP_AUTH_ENABLED=true` / `GCP_DEPLOY_ENABLED=true` のGCP経路だけです。
未設定・falseを旧Supabase/Vercel配信へfallbackさせません。認証前に固定context・GCPモードを確認します。
CIはmainの同じSHAに対して軽量検証と変更内容に必要な実境界試験を実行し、
docs/pipelineだけの変更ではCloud認証・本番image build・配備を省略します。
repository variablesと短期OIDCを使用し、`production` environment・旧Supabase/Vercel secretsは使用しません。
Cloud Runのtemplateと実際の100% serving revisionが要求モードと一致しなければbuildやDB更新前に停止します。

`Deploy Production` のmanual実行は固定mainの認証preflightだけです。固定Cloud RunへGETを1回行い、
認証・既存service/digest/runtime modeを確認します。先にCIをmainで手動実行し、成功した同SHAのci_run_idを入力します。
CIrunのworkflow/event/main/SHA/成功をGitHub APIで認証前とCloud GET前に再確認します。
このGET-only実証は通常配備flag GCP_DEPLOY_ENABLED=falseのままでも実行できます。build/upload/Job実行/DB変更/traffic変更を行わず、
配備権限・復元可能性まで実証したとは扱いません。WIFのmanual event許可は別途レビューが必要です。

GCPの公開・サーバーフラグは両方trueで一致し、build時のSupabase公開値は無効な固定placeholderです。
設定取得にVercelを使いません。既存3secretとDB password / Identity Platform API keyの2secretは、
コミット済みの固定project/正のversion番号への参照を使います。`latest`や生のserver secretを公開manifestへ入れません。
任意のSentry設定は、コミット済みの `production-sentry-secret-version.json` で固定versionを指定できます。初回配信時に参照を追加し、既存の参照と異なる場合は停止します。secretの値は読み取りません。

runtimeは既存の単一container / 1CPU / 1GiB / concurrency2 / min0-max1を検査します。
Direct VPCは `mfmf-db-network` / `mfmf-app-tokyo` / `PRIVATE_RANGES_ONLY` 固定で、connectorやNATを作りません。
通常配信がこれらの資源設定を変更することもありません。

## 未配信差分と停止条件

本番候補ではGitHub Actionsの実Cloud Run build jobを全run/attemptから調べ、最後に成功した配備SHAとの差分も試験選択へ合流します。
docs/pipeline-onlyのpushは配備候補にせず、履歴探索・有料buildのcatch-upも行いません。
最新の実buildが失敗・取消・不明なら古い成功を基準に自動再試行しません。履歴/API/祖先関係を証明できない場合も全heavy試験＋CD停止にします。
探索は最大1000run/1200GETに制限し、上限や欠落を『配備してよい』とは扱いません。
mainは同じSHAのgate成功を要求します。失敗不明時は実Cloud状態と費用・証拠を確認して復旧を判断してください。
履歴によるsource証明は、この固定workflow以外からのCloud変更を自動検出しません。
手動・別経路で変更する場合は先にGCP_DEPLOY_ENABLED=falseでCDを停止し、稼働revisionのimage digestとsource SHAを実読取で再照合してから再開します。
初回のprivate移行時も同じlive digest/source照合を行い、GitHub成功履歴だけで稼働一致と断定しません。

## DB更新ジョブ

同じmain SHAからapp imageと `Dockerfile.gcp-operator` imageをbuildし、両方のdigestを確定します。
既存の `mfmf-db-operator` Jobだけを取得・検査し、ETag付きでimageとdeploy SHAを更新して実行します。
Jobの作成、IAM変更、任意command/SQL/override、import、restore、初期baseline適用は通常配信に含めません。
DB更新前には同じimage/SHAの既存2バックアップJobも更新・実行し、両方の成功を要求します。
専用SA・日次実行・初期受入は[バックアップ運用](./gcp-backup-automation.md)を参照してください。

配信主体 `mfmf-deploy` には、固定Jobだけでcustom role `mfmfDatabaseDeployer` を付与します。
権限は `run.jobs.get/update/run`・`run.executions.get`・`run.operations.get` の5つです。
operator SAだけに既存の `roles/iam.serviceAccountUser` を使い、project全体のRun管理者権限は付けません。
この組合せはJobを通じてoperator権限を使用できるため、main限定WIFとレビュー済みworkflow・固定Job検査が信頼境界です。
権限不足時に未更新のJobを確認せず、無条件で再実行しないでください。

Jobは専用SA、single task/parallel1、retry0、timeout1800秒、1CPU/1GiB、GEN2、固定Direct VPC、
`args=["--execute"]`、`MFMF_DB_OPERATION=upgrade` に固定します。
資格情報は `mfmf-db-operator-credentials` version1への参照だけです。
実行結果のJob名・image digest・main SHA・単一成功・再試行なしを確認した後だけ、新appをtag付き0%でstageします。
その後は既存の匿名smokeとETag/traffic所有確認を通して100%へpromoteします。

DB Jobの失敗は固定stage・HTTP status・`mutationBoundary`だけをログに残し、API本文や資格情報を出力しません。
`none`はJobへの変更リクエスト送信前、`update-requested` / `run-requested`はそれぞれ送信直前まで進んだ意味です。
送信済みでも適用成功は保証しません。失敗・通信不明時はJob・Execution・operationを確認し、診断値だけで再送しません。

operatorはsource migration集合とchecksum ledgerを確認し、advisory transaction lockの内側でSQLを適用します。
baselineが無い、既適用SQLのhashが違う、元Supabase migrationへの対応が未確認なら停止します。
新SQLは旧app revisionとも互換にしてください。appのtrafficを戻しても、適用済みSQLを自動で逆実行しません。

## 更新直前バックアップと保持期限

未適用SQLが0件ならバックアップAPIは呼びません。1件以上の時だけ、同じlock内で
新しい [Backups.CreateBackup API](https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/Backups/CreateBackup) に
固定instance・Tokyo・`ttlDays=14`・main SHAを含む固定markerを送ります。
完了後のresourceでSUCCESSFUL・同一instance/marker・開始と完了時刻を検査してからSQLへ進みます。
Standard構成では要求後も`expiryTime`がNULLでした。期限指定だけで14日後の削除は保証されません。
そのため、[日次保持Job](./gcp-backup-automation.md#sql-の保持契約)の30時間以内の成功receipt、
同じinstance作成時刻・現在の設定・実装hashを作成前に検査し、完了後にも同じreceipt世代を再確認します。
この外部保持契約が確認できた場合だけNULL expiryを許可します。期限が返る場合は残存1〜14日の検査も維持します。
receipt欠落・古さ・実装や世代の変化はSQL適用前に停止します。日次Jobの初期実受入とScheduler有効化を別に確認してください。

同じSHAのmarkerを完全にlistし、一意かつ15分以内に**開始した**backupだけ再利用します。
古い・重複・pending/failedのbackupがあれば、同じ名前のbackupを増やさずoperator確認へ止めます。
開始・完了時刻は両方必須で順序も検査し、時計ずれ許容は30秒です。新規作成時は今回のrequest開始以降であることも確認します。
[API仕様](https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/Backups)では、開始時刻までの書込が収録されるため、
完了が最近という条件だけで古いbackupを再利用しません。

固定instanceの全ON_DEMAND backup（他markerを含む）は8件、`maxChargeableBytes` 合計1 GiBを上限にします。
一覧の固定名を全件個別GETで補完します（一覧レスポンスは容量を省略するため）。
一覧不完全、未知の型・容量、上限超過で止め、新規作成には件数・容量の空きが必要です。
作成後・再利用前にも取得したresourceの容量を検査します。AUTOMATED / FINALはこの手動backup枠に含めません。
これは作成を抑止する検査であり、請求の厳密な上限ではありません。新規backupの容量は完了後に判明し、
別operatorの同時操作や後の容量変化もあり得ます。超過時に復元点を自動削除しません。

このprebackup helper自身はbackupを削除しません。日次Jobが所有marker・14日経過・48時間以内の新しい復旧点等を
確認して削除します。他markerの初回移行用backupは対象外です。自動backup保持14件と手動backupの保持は別契約であり、
件数を空けるために必要な復旧点を早期削除しません。実削除と復元の証明範囲は[受入手順](./gcp-backup-automation.md#受入障害時復元)で分けます。

必要IAMは `cloudsql.backupRuns.create/get/list` と `cloudsql.instances.get`（operation取得）です。
専用operator SAにだけ付け、通常deployerへSQL管理者権限を付けません。
operatorはさらに非公開ops bucketの固定`retention/latest.json`だけをGETでき、receiptの作成・更新権限は持ちません。
[公式のAPI別permission表](https://docs.cloud.google.com/sql/docs/postgres/iam-permissions?hl=en) を参照してください。

## 検証

CIはfalse/true双方のcontainer build、隔離PostgreSQL baseline/復元、実PostgRESTのpool2での認可、
source freeze fixture、operatorのoffline planと各境界テストを実行します。
これらは架空データだけで動作し、実DB/Authの移行・復元・ログイン確認の代わりにはなりません。
最終source snapshotの作成と解除は[DB/Authバックアップ手順](./database-auth-backup.md)に分離しています。
