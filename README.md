# Tasks — 短期 / 中期 / 長期のタスク管理 PWA

Twitter ライクな投稿画面でタスクを放り込み、**短期・中期・長期**の 3 つの枠で管理する PWA です。
投稿画面と一覧画面は分かれていて、一覧の右下の **+** から投稿画面に切り替わります。
ビルド不要の静的ファイルのみで構成されているので、GitHub Pages にそのまま置けます。

- **3 層のタスク** — 枠ごとに別テーブル。短期 → 中期 → 長期 と上位に紐づけられる
- **Twitter like な投稿** — 1 つのテキストエリアと枠チップだけで投稿、`Ctrl/⌘ + Enter` で送信
- **画面分離** — 一覧 (`#`) / タスク詳細 (`#t/<id>`) / 投稿 (`#new`) は別画面。端末の戻るボタンで一段ずつ戻れる
- **下位タスクの追加** — 中期・長期タスクを開いて投稿すると、既定でその下位タスクになる
- **テーマ切替** — 自動 (OS 追従) / ライト / ダークを ⚙ から選べる。選択は端末ごとに保存
- **オフラインファースト** — localStorage が正本のキャッシュ。圏外でも投稿でき、復帰時に同期
- **端末間同期** — Supabase (Postgres + Auth + Realtime) で PC ⇄ スマホを同期
- **インストール可能** — manifest + Service Worker でホーム画面に追加できる

---

## 1. 構成

```
index.html              画面
css/style.css           スタイル (ライト/ダーク自動)
js/app.js               UI とイベント
js/store.js             ローカルストア (localStorage / 論理削除 / dirty 管理)
js/sync.js              Supabase 同期 (push → pull / Realtime 購読)
js/config.js            Supabase の URL と anon key (任意。空でも可)
sw.js                   Service Worker
manifest.webmanifest    PWA マニフェスト
icons/                  アイコン
supabase/schema.sql     Supabase に流す DDL
.github/workflows/      GitHub Pages への自動デプロイ
```

依存はランタイムの Supabase JS SDK (jsDelivr から ESM で動的 import) のみ。
npm も bundler も不要です。

---

## 2. ローカルで動かす

`file://` では ES modules と Service Worker が動かないので、簡易サーバーを立ててください。

```sh
python3 -m http.server 8080
# → http://localhost:8080
```

Supabase を設定しなくても、その端末だけのタスク管理としてすぐ使えます。

---

## 3. Supabase のセットアップ

### 3-1. プロジェクトとテーブル

1. <https://supabase.com> でプロジェクトを作成
2. ダッシュボードの **SQL Editor** に `supabase/schema.sql` を貼り付けて実行

作られるもの:

| テーブル | 役割 | 上位への参照 |
|---|---|---|
| `tasks_long`  | 長期 | — |
| `tasks_mid`   | 中期 | `long_id → tasks_long` |
| `tasks_short` | 短期 | `mid_id → tasks_mid` / `long_id → tasks_long` |

いずれも RLS 有効で「自分の行だけ」読み書きできます。削除は `deleted` フラグによる
論理削除で、端末間に削除が伝わるようにしています。`updated_at` はトリガーで
サーバー時刻に固定されるため、端末の時計がずれていても同期が壊れません。

### 3-2. 認証 (メールのマジックリンク)

**Authentication → URL Configuration** に、公開 URL を登録します。

- Site URL: `https://<ユーザー名>.github.io/<リポジトリ名>/`
- Redirect URLs: 上と同じ URL（ローカル検証用に `http://localhost:8080/` も追加）

### 3-3. アプリ側に接続情報を入れる

どちらでも構いません。

- **A. 画面から**: 右上の ⚙ → Project URL と anon public key を貼って「保存して接続」。
  その端末のブラウザに保存されます。
- **B. コードに埋め込む**: `js/config.js` を編集します。

  ```js
  export const SUPABASE_URL = 'https://xxxx.supabase.co';
  export const SUPABASE_ANON_KEY = 'eyJhbGciOi...';
  ```

anon key は公開される前提のキーで、実際のアクセス制御は RLS が行うため
リポジトリに含めて問題ありません（`service_role` key は絶対に置かないでください）。

最後に ⚙ の「ログイン」からメールアドレスを入れ、届いたリンクを各端末で開けば、
同じアカウントの端末同士が同期されます。

---

## 4. GitHub Pages へのデプロイ

```sh
git add -A
git commit -m "init"
git branch -M main
git remote add origin git@github.com:<ユーザー名>/<リポジトリ名>.git
git push -u origin main
```

リポジトリの **Settings → Pages → Build and deployment** で

- **Source**: `Deploy from a branch`
- **Branch**: `main` / `/ (root)`

を選んで Save すると、push のたびに GitHub が自動で公開します。

パスはすべて相対指定なので、`https://<user>.github.io/<repo>/` のような
サブディレクトリ配信でもそのまま動きます。`.nojekyll` も同梱済みです。

> 更新が反映されないときは、Service Worker が古いシェルを掴んでいます。
> `sw.js` の `VERSION` を上げてから push してください。

---

## 5. 使い方

| 操作 | 方法 |
|---|---|
| 投稿画面を開く | 一覧の右下の **+**、または **`n`** / **`c`** キー（URL は `#new`） |
| タスクを開く | カード本文（またはツリーの行）をクリック（URL は `#t/<id>`） |
| 下位タスクを追加 | 中期・長期タスクを開く → 右上の **＋ 下位タスク** / **`n`** キー。枠と上位タスクが既定で入る |
| 投稿 | 本文を書く → 枠チップ（短期/中期/長期）を選ぶ → 右上の「投稿」 |
| 一覧に戻る | 左上の ← / 端末の戻る / `Esc`（投稿すると自動で戻る） |
| 送信ショートカット | `Ctrl + Enter` / `⌘ + Enter` |
| 画面を閉じる | `Esc`（投稿・詳細・設定） |
| 上位への紐付け | 短期・中期を選ぶと「紐づける上位タスク」が出る |
| 完了 | カード左の ○ |
| 編集・紐付け変更 | カードの「編集」 |
| 階層の確認 | 「ツリー」タブ |
| テーマ変更 | ⚙ → 表示テーマ（自動 / ライト / ダーク） |
| バックアップ | ⚙ → JSON 書き出し / 読み込み |

短期タスクは中期だけでなく長期へ直接ぶら下げることもできます（例: 「毎朝 30 分英語」を
長期目標に直結させる）。削除してもぶら下がっていたタスクは消えず、紐付けだけ外れます。

---

## 6. 同期の仕組み

1. 変更はまずローカルに書かれ、`dirty` フラグが立つ
2. `push` — `dirty` な行を 長期 → 中期 → 短期 の順に upsert（FK 順）
3. `pull` — 前回取得時刻より新しい行を 3 テーブルから取得し、
   `updated_at` が新しい側を採用（last-write-wins）
4. ログイン中は Realtime を購読し、他端末の変更を即時反映
5. オンライン復帰・タブ復帰・投稿のたびに同期を実行

オフライン中の変更は `dirty` のまま残り、接続が戻った時点で送信されます。
