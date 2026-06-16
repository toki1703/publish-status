# Publish Status

Obsidian のファイルエクスプローラーに、Obsidian Publish の公開ステータスを VSCode の Git ステータス風に表示するプラグインです。

## 機能

ファイルエクスプローラーの各ファイル名の右側に、Obsidian Publish との同期状態を示す1文字のバッジを表示します。

| バッジ | 色 | 意味 |
|---|---|---|
| `A` | 緑 | Added — 新規追加（未公開） |
| `M` | 黄 | Modified — 公開済みだが変更あり |
| `D` | 赤 | Deleted — ローカルで削除済み |

## 動作条件

- Obsidian v1.12.0 以上
- Obsidian のコアプラグイン「Publish」が有効になっていること

## インストール

1. Obsidian の設定 → コミュニティプラグイン → コミュニティプラグインを閲覧 で「Publish Status」を検索
2. インストール → 有効化

### 手動インストール

`main.js`、`styles.css`、`manifest.json` をボルトの `.obsidian/plugins/publish-status/` フォルダにコピーしてください。

## 使い方

プラグインを有効化すると、起動時に自動でステータスを取得します。以下のタイミングでも自動更新されます。

- アクティブなファイルを切り替えたとき
- ファイルを編集したとき

手動で更新したい場合は、次のいずれかを使用してください。

- リボンの **Refresh Publish Status** アイコン（雲に矢印のアイコン）をクリック
- コマンドパレットから **Publish Status: Refresh Publish Status** を実行

## ライセンス

[MIT License](LICENSE.txt)

## 作者

[ときくん](https://github.com/toki1703)
