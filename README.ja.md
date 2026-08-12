# grok-x-search-mcp

Cloudflare Workers 上で動作する、非公式・非公開・単一ユーザー向け Grok
検索 MCP サーバーです。ChatGPT Web を対象とし、OAuth 状態を 1 個の
SQLite Durable Object に保存し、Workers Web Crypto の AES-256-GCM で認証
情報を暗号化します。

**言語:** [English](README.md) | 日本語 | [中文](README.zh.md)

> 本プロジェクトは xAI、X、OpenAI、Cloudflare との提携・承認関係はありま
> せん。Grok CLI/Hermes 互換フローの公開 OAuth client ID を再利用します。
> 上流の OAuth/API や利用規約は変更される可能性があります。

## 現在の実行契約

- Worker 名: `grokmcp`
- ヘルスチェック: `GET /healthz`
- MCP: `https://grokmcp.<account>.workers.dev/t/<MCP_URL_TOKEN>/mcp`
- 管理画面:
  `https://grokmcp.<account>.workers.dev/admin/t/<ADMIN_URL_TOKEN>`
- MCP プロトコル: `2026-07-28` のみ。各リクエストは独立し JSON を返す
- MCP ツール: `x_search` と `web_search` のみ
- 状態: `single-user` という 1 個の SQLite Durable Object
- モデル: Worker 変数 `GROK_X_SEARCH_MODEL`。現在の既定値は `grok-4.5`

旧 initialize/session MCP クライアント、SSE 転送、アカウント管理 MCP
ツール、旧 xAI raw response fallback は意図的にサポートしません。

## 無料枠の境界

Web Crypto は Workers 組み込み機能で、別料金はありません。この構成で使う
のは Worker、1 個の SQLite Durable Object、Worker 変数、Worker secrets
だけです。低頻度の個人利用を、現在の [Workers Free 上限](https://developers.cloudflare.com/workers/platform/limits/)
と [Durable Objects Free 枠](https://developers.cloudflare.com/durable-objects/platform/pricing/)
内に収める設計です。Cloudflare の上限は変更される可能性があり、互換性のある
Grok/X サブスクリプションは別途必要です。

## インストール、検証、デプロイ

必要なものは、`workers.dev` を有効にした Cloudflare Free アカウント、個人用
Grok/X アカウント 1 個、Node.js 22 以降、npm です。

次のコマンドはローカル Worker を起動しません。

```bash
npm ci --cache .npm-cache
npm run secrets:init
npx wrangler login
npm run types
npm run check
npm run typecheck
npm test
npm audit --audit-level=low --cache .npm-cache
npm run deploy:dry
npm run deploy:with-secrets
```

`deploy:with-secrets` は初回デプロイまたは明示的な secret rotation 専用です。
通常のコード更新では secrets file なしの `npm run deploy` を使います。
Cloudflare は必須名を検証し、既存の暗号化値を保持します。

`npm run secrets:init` は Git 対象外かつモード `0600` の
`.secrets.local` を作成または検証します。3 個の独立した 256-bit 値を含み
ます。

- `MCP_URL_TOKEN`: ChatGPT MCP URL に埋め込むパスワード
- `ADMIN_URL_TOKEN`: 管理画面 URL に埋め込む独立したパスワード
- `TOKEN_ENCRYPTION_KEY`: SQLite OAuth レコード用 AES キー

既存のローカル値は保持され、コマンドが表示することもありません。Cloudflare
は初回デプロイ時に値を受け取りますが、後から元の値を表示しません。別の安全な
バックアップは有用ですが、通常の Wrangler デプロイは既存 Worker secrets を
削除しないため、コード更新には必須ではありません。

デプロイ後、Wrangler が表示した実際のベース URL を使います。

```bash
npm run url -- https://grokmcp.<account>.workers.dev
npm run admin-url -- https://grokmcp.<account>.workers.dev
```

この 2 コマンドは保護 URL を意図的に表示します。両方をパスワードとして扱い、
コミット、スクリーンショット、ログ記録、共有をしないでください。

## ChatGPT Web へ接続

現在の [OpenAI カスタム MCP 接続手順](https://developers.openai.com/plugins/deploy/connect-chatgpt)
に従い、`/mcp` で終わる完全な MCP URL を貼り付けます。Authorization header
や OAuth 情報を追加しません。認証は URL token に含まれています。

クライアントは MCP `2026-07-28` の request envelope と標準 header を
サポートする必要があります。成功呼び出しは JSON を返し、MCP セッションは
作成しません。

## Grok にログイン

ログイン、状態確認、callback、logout は MCP ツールとして公開しません。保護
された管理 URL をブラウザーで開きます。

1. **Start a new Grok login** を選択します。
2. 生成された認可リンクを開き、対象の Grok/X アカウントでログインします。
3. Grok は `http://127.0.0.1:56121/callback?...` へ移動します。ローカル
   listener は不要なので、接続エラー表示は正常です。
4. アドレスバーの完全な URL を、`code` と `state` を 1 個ずつ含めてコピーし、
   10 分以内に Worker 管理画面へ貼り付けます。
5. 管理画面が **Signed in** と表示することを確認します。

callback URL は短時間だけ有効な認証情報です。共有したり、認可 code だけを
コピーしたりしないでください。

## 検索ツール

両ツールは MCP `outputSchema` を宣言します。成功時は一致する
`structuredContent` と、同内容の JSON text block を返します。

```json
{
  "ok": true,
  "text": "回答テキスト",
  "citations": ["https://example.com/source"],
  "model": "grok-4.5"
}
```

| ツール | 入力 |
|---|---|
| `x_search` | 必須 `query`。任意の `allowed_x_handles` または `excluded_x_handles`（最大 20、同時指定不可）、実在する `from_date`/`to_date`（`from_date <= to_date`）、`enable_image_understanding`、`enable_video_understanding` |
| `web_search` | 必須 `query`。任意の `allowed_domains` または `excluded_domains`（最大 5、同時指定不可）、`enable_image_search`、`enable_image_understanding` |

クエリー上限は 8,000 文字です。上流呼び出しは 60 秒で timeout、response
上限は 2 MiB、citation は重複除去され、検索履歴は保存されません。

## モデル変更と Worker 更新

`wrangler.jsonc` の `GROK_X_SEARCH_MODEL` を変更し、全検証後に再デプロイ
します。無効なモデル名は `grok-4.5` に戻ります。

一時 checkout が削除済みなら、secret-free source archive を復元して SHA-256
を検証します。新しい非公開ディレクトリへ展開し、`npm ci` と
`secrets:init` 以外の全検証を実行します。`npx wrangler whoami` を確認し、
`npm run deploy` を実行してください。既存 Worker の通常更新にローカル secret
file は不要で、Cloudflare が必須名を検証して値を保持します。暗号化 SQLite
状態を維持するため、`GrokState` class、migration 履歴、`single-user` object
名を保持します。

保護された管理画面には application version、deployment version、現在の
model、公開 OAuth 互換情報、ログイン状態、復元可能な MCP URL が表示されます。
コード更新には source archive が必要です。

## Secret rotation

- `MCP_URL_TOKEN` の交換で旧 ChatGPT URL が無効になります。その後 ChatGPT
  接続を更新します。
- `ADMIN_URL_TOKEN` の交換で旧管理 URL が無効になります。
- `TOKEN_ENCRYPTION_KEY` は Grok へ再ログインできる場合だけ交換します。既存
  OAuth ciphertext は設計どおり読めなくなります。

Cloudflare Workers → `grokmcp` → Settings → Variables and Secrets で対象名
だけを rotation するか、`wrangler secret put` を使用し、その保護 URL を再構築
して保存します。URL rotation のために暗号化キーを交換しないでください。
ローカル復旧ファイルがない場合も、この方法がサポートされます。

## セキュリティ

- token がない、または不正なパスは、body parse や Durable Object access の
  前に `404` を返します。
- MCP token と管理 token は独立し、相互利用できません。
- 管理操作は same-origin form POST のみです。画面は script-free、no-cache、
  no-referrer、frame 不可です。
- OAuth attempt と token set は purpose-bound AES-GCM record として暗号化保存
  します。
- 永続的 refresh 拒否は無効 credential を削除し、一時的 OAuth/xAI failure
  では retry のため保持します。
- URL path に bearer token があるため Worker invocation observability は無効
  のままです。versioned diagnostics 用 source map は upload します。
- 単一ユーザー設計です。共有・multi-tenant service として公開しないでください。

## ライセンス

[MIT](LICENSE)
