# mfmf — ハッカソン提出準備用コピー

mfmfのコードを審査・提出向けに整理するための独立したスナップショットです。
ペットの日々の記録・予定・体重・写真を家族やケア担当者と共有し、記録に基づいて引き継げる環境を目指しています。

- 元ソース: `godhuu0505/mfmf` の `8f6b3af317af7e33a708922a1d087c52897d18ef`（2026-11-08取得）。[出典とコピー範囲](SUBMISSION.md)。
- 既存作品のコピーです。このリポジトリの作成日を、作品や各機能の開発日として扱いません。
- アプリのソース・スキーマ・テストを保持し、Git履歴とGitHub Actionsワークフロー、生成元を確認できなかった説明用画像6点は含めていません。GitHubアカウント側の本番設定・配信接続、実データや資格情報は引き継ぎません。ソースに含まれる運用資料は元プロジェクトの記録です。
- 初期状態は非公開・Actions無効。公開・OSSライセンス付与・各大会への応募送信はそれぞれ別に判断します。
- このコピーから本番配備、課金APIの実行、実利用者データの取り込みを行わないでください。動作確認はローカル環境と架空データで行います。
- 現在の権利表示を維持します。公開リポジトリで閲覧できることと、OSSとして再利用できることは別の条件です。

以下はコピー元の開発ドキュメントです。本番URL・配備・CIの説明は元プロジェクトについての記述であり、このコピーの配信手順ではありません。
ローカル環境の手順は下記「B. ローカル Supabase スタック」を参照してください。クラウド環境の作成や接続は行っていません。

---

# mfmf

> ペット保育園記録アプリ（フェーズ1）— 保育園からの日々の記録（テキスト＋写真）を残し、夫婦で振り返るためのミニマムな PWA。

![Next.js](https://img.shields.io/badge/Next.js-15-black)
![Google Cloud](https://img.shields.io/badge/Google_Cloud-Run%20%2F%20SQL%20%2F%20Storage-4285F4)

家族で 1 つの世帯を共有し、保育園とおうち（両親）どちらのノートも同じ仕組みで記録します。
世帯には **editor / viewer** で招待でき（owner は参加後に既存 owner が昇格させる）、保育園やシッターは対象ペット・期間を
限定した外部ゲストとして招けます。
本番は **Next.js（App Router）/ Cloud Run**、認証は **Identity Platform**、DBは **Cloud SQL PostgreSQL**、
写真・アバターは **Cloud Storage（GCS）** です。ローカル開発は引き続きSupabaseを使用します。
入口は [Cloud Run](https://mfmf-candidate-wspqvmhj6q-an.a.run.app/) で、旧Vercel URLは新しい入口へ誘導します。
認証の移行後は再ログインが必要です。旧originのPWAは新しい入口で再登録してください。
GCPは従量課金で、月3,000円は使用量・無料枠に条件がある運用目標です。予算通知は自動停止ではありません。
切替受入と費用の前提は [GCP移行記録](./docs/explanation/gcp-migration.md#現在の実装と切替記録)を参照してください。

## クイックスタート

ログインは **Google OAuth** と **メール/パスワード**の 2 方式。
Google ログイン（および Drive 連携）を使う場合は Google Cloud Console での
OAuth クライアント発行が必要です。セルフ登録（`/signup`）は `SIGNUP_ENABLED=true` のときだけ開きます。

### A. リモート Supabase に繋ぐ（最短）

開発用のSupabaseプロジェクトを使う場合です。本番Cloud SQLへの接続手順ではありません：

```bash
git clone https://github.com/godhuu0505/mfmf-hackathon.git
cd mfmf-hackathon
npm install

cp .env.local.example .env.local   # Supabase の URL / anon key を設定
just dev                           # http://localhost:3000
```

詳しい手順（Supabase プロジェクト発行と Google プロバイダ設定含む）は
**[docs/getting-started.md](./docs/getting-started.md)**。

### B. ローカル Supabase スタックを使う（推奨）

Docker（Docker Desktop / Rancher Desktop など）と `just` / Supabase CLI を導入：

```bash
brew install just supabase/tap/supabase
git clone https://github.com/godhuu0505/mfmf-hackathon.git && cd mfmf-hackathon
npm install
```

```bash
just setup           # Supabase 起動 + .env.local 自動生成（URL/anon key/TOKEN_ENC_KEY）
just up              # docker compose で Next.js 起動（CI と同じ Node 22）
# または just dev でホスト Node 起動
```

**Google ログイン / Drive 連携を使う場合のみ**、追加で OAuth クライアントの発行が要ります
（初回 1 回だけ・約 5 分）。リダイレクト URI に `http://127.0.0.1:54321/auth/v1/callback` を
登録（`localhost` ではなく `127.0.0.1`）。発行手順は
[docs/guides/google-drive-setup.md](./docs/guides/google-drive-setup.md) 1 章。

```bash
just setup-google    # CLIENT_ID/SECRET を対話入力 → 全箇所に投入 + Supabase 再起動
```

**メール/パスワードだけで動かす場合**は上記は不要です。ローカルで自分のアカウントを
作る手順:

1. **`just up` / `just dev` を実行する前に**、`.env.local` に `SIGNUP_ENABLED=true` を設定
   （本番では既定で閉じています）。
   `docker-compose.yml` は `.env.local` を `env_file` で読むため、**起動後に編集しても
   すでに動いているコンテナには反映されません**。あとから変えた場合は
   `just down && just up`（`just dev` ならプロセスを再起動）
2. `/signup` で登録する
3. **確認メールは実際のメールボックスには届きません。** ローカルスタックは
   `enable_confirmations = true`（`supabase/config.toml`）で、メールは Mailpit が受け取ります。
   **`http://127.0.0.1:54324` を開いて確認リンクを踏んでください**
4. `/login` からログイン

> ⚠️ この構成でも **`/login` の「Google でログイン」ボタンは表示されます**が、Supabase 側で
> Google プロバイダが無効（`supabase/config.toml` の `[auth.external.google] enabled = false`）
> なので、押すと `/login?error=oauth` に戻ります。**メール/パスワードのフォームを使ってください。**
> ボタンを出し分けていないのは、Google が使えるかどうかが Supabase 側の設定で決まり、
> アプリからは判定できないためです（→ [docs/explanation/decisions.md](./docs/explanation/decisions.md) の未決事項）。

詳細・トラブルシュートは **[docs/guides/local-supabase.md](./docs/guides/local-supabase.md)**。

### よく使う just コマンド

```bash
just                # 利用可能な recipe を一覧
just dev            # ホスト Node で next dev
just up             # docker compose で Next.js をコンテナ起動
just down           # コンテナを停止
just check          # 素早いローカル確認（lint / typecheck / unit / build）
just check-all      # PR前の全ローカル検証（実DB・E2E/VRT・Docker含む）
just setup          # 初回のみ：ローカル Supabase 起動 + .env.local 生成
just setup-google   # 初回のみ：Google OAuth 認証情報を対話投入
```

## 検証と無料枠でのCI

PR前は `npm run check:local`（`just check-all`）を実行し、結果をPRに記録します。
現在のソースを `work/local-check-*` に隔離し、既存envファイル・クラウド資格情報を渡さず、
unit・MCP emulator・DB/RLS/復元・integration・Docker・E2E/VRTをローカルで確認します。
Node 22、locked dependencies、Java 21、age、Docker、Supabase CLI 2.111.0、Playwright Chromiumが必要です。
VRTは既存baselineと同じLinux/Chromium/Noto CJK環境で実行します。
既存の `supabase_db_mfmf` がある場合は再利用・停止せず中断します。
`-- --suite fast` 等で個別再実行でき、`--keep` で隔離出力と画面キャプチャを残せます。
UI変更PRにはローカルの架空データによる画面キャプチャを添付します。

GitHub Actionsはlint・型・限定した認証/配備security試験・offline保全試験を中心にします。
DB/RLS・認証・operator・依存/コンテナ等の重要変更では対応する実境界試験を残し、
履歴不足・未知の変更・手動CIでは全試験を選択します。`CI gate` は選択したjobの成功だけを認め、
失敗・cancel・予期しないskipを通しません。mainでも配備する同じSHAを検証します。
docs・pipelineだけの変更では本番image buildや配備を行いません。
本番候補では直近pushだけでなく最後の実配備SHAからの未配信差分も試験選択へ合流します。
GitHubの全run/attemptを実配備の完了順で確認し、CI成功でも配備skipのrunは基準にしません。
最新の実buildが失敗・取消・不明、履歴欠落、探索上限（1000run/1200GET）に達した場合は全試験を選びCDを停止します。
不明な有料操作を自動再実行せず、実際のCloud状態・証跡・追加費用を確認してから復旧を判断します。

Freeの非公開repoはアカウント全体のActions無料枠を共有します。追加予算は**$0・上限時停止**を維持し、
枠が尽きればCI/CDが止まる運用です。4アプリとinfra合計600分/月は目標であり、実走のjob分を測って調整します。
GitHubの$0予算はCloud Build・Cloud Run・Artifact Registry等のクラウド費用を止めません。
費用の発生する本番build・配備・復元試験の前には、実行内容と追加費用見込みを利用者へ伝えます。

## 主な機能

- **記録の CRUD** — 日付＋本文。一覧（サムネ＋抜粋）/ 詳細 / 編集 / 削除。
- **検索・絞り込み・並び替え** — 本文・記入者のキーワード検索（`pg_trgm`）、記録元・期間での絞り込み、日付/体重での並び替え、ページネーション。条件は URL クエリ（`?q=&from=&to=&source=&sort=&page=`）に同期され、共有・リロードで再現できる。
- **写真の紐付け** — 1 記録に複数枚。GCSでは期限・サイズ付きのURLで一時領域へアップロードし、サーバーで画像と権限を確認してから公開対象にする。詳細は[画像ストレージの契約](./docs/reference/media-storage-ledger.md)。
- **記録メタデータ** — 記録元（🏫 保育園 / 🏠 おうち）・記入者・体重(kg)。記録元で絞り込み、体重は推移グラフへ。
- **PWA** — ホーム画面に追加、スタンドアロン表示、オフラインフォールバック。
- **ご意見・不具合フォーム** — どの画面からでも送信。内容はアプリDBにのみ保存（フォームからGitHubには送らない）。

## ドキュメント

詳細は **[docs/](./docs/README.md)** に [Diátaxis](https://diataxis.fr/) で整理しています。

| 知りたいこと | ドキュメント |
| --- | --- |
| まず動かす | [docs/getting-started.md](./docs/getting-started.md) |
| ローカル Supabase / つまずき | [docs/guides/local-supabase.md](./docs/guides/local-supabase.md) |
| デプロイ・リリース | [docs/guides/deploy.md](./docs/guides/deploy.md) |
| 動作確認 | [docs/guides/verify-backend.md](./docs/guides/verify-backend.md) |
| 構成の地図・環境変数 | [docs/reference/](./docs/reference/architecture.md) |
| 判断基準（Mission / Vision / Values） | [docs/explanation/principles.md](./docs/explanation/principles.md) |
| 決定ログ（却下した案と理由） | [docs/explanation/decisions.md](./docs/explanation/decisions.md) |

AI コーディングエージェント向けの作業指針は [AGENTS.md](./AGENTS.md) / [CLAUDE.md](./CLAUDE.md)。

## ライセンス

私的利用のためのプロジェクトです。
