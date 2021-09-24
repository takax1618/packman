# Packman

## 概要

ecBeingのリリースモジュールをひとつのディレクトリにまとめるツールです。

おもに以下の機能を備えています。

- SVNログの一覧を表示し、そこからパッケージに含めるリビジョンを指定可能
- TortoiseSVN等で調べたリビジョン番号を直接指定することでもパッケージを作成可能
- コミットされたVB/CSファイルから依存関係を解決し、リリースが必要なモジュールを抽出
- 設定はファイルに保存し、2回目以降はリビジョン指定のみでパッケージを作成可能
- リリースから除外するモジュールを指定可能



## インストール

Packman の動作には以下が必要です。

- Node.js
- SVN Command Line Tools

以下の手順でインストールを進めてください。

### Node.js のインストール

https://nodejs.org/ja/ にアクセスし、Node.js のインストーラをダウンロードしてください。
安定版 (LTS) を推奨します。

ダウンロードしたインストーラを起動し、画面の指示に従って Node.js をインストールしてください。
(基本的にすべてデフォルト設定で大丈夫なはずです)

### SVN Command Line Tools のインストール

このツールは TortoiseSVN のインストーラに付属しているため、まずはそちらを取得します。

https://tortoisesvn.net/downloads.html にアクセスし、ご利用のOSに合わせたインストーラをダウンロードしてください。

ダウンロードしたインストーラを起動し、画面の指示に従って TortoiseSVN をインストールしてください。

インストール内容を選択する画面で "command line client tools" のアイコンを選択し、
"Will be installed on local hard drive" を選択してください。

その他はデフォルト設定で大丈夫です。

### Packman のインストール

配布パッケージ内の「packman」フォルダを、
適当なフォルダにフォルダごとコピーしてください。
ここでは C:\Tools\ にコピーしたとして話を進めます。

次に、コマンドプロンプトで「packman」フォルダに移動し、 `npm install` を実行してください。

#### 例

```
C:\Users\shimbota>cd c:\Tools\packman

c:\Tools\packman>dir /b
CHANGELOG.md
make.js
package.json
packman.js
README.txt
svn.js

c:\Tools\packman>npm install
npm notice created a lockfile as package-lock.json. You should commit this file.
npm WARN Packman@0.2.0 No repository field.

added 62 packages from 84 contributors and audited 62 packages in 5.209s

13 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
```

これでPackmanを利用する準備ができました。

### Packman のアップデート

Packman をアップデートする場合は、 `packman` フォルダを最新版の内容で上書きした後、
対象フォルダで `npm update` を実行してください。


## 使い方

Packman をインストールしたフォルダで `npm run packman` を実行してください。

例:
 
```
c:\Tools\packman>npm run packman
```

あとは画面上に出てくる説明に沿ってコマンドを実行してください。

初回起動時はプロジェクト設定の入力と、依存関係の収集を求められます。
(依存関係の収集は、コミットされたソースファイルからリリースするDLL/EXEを判定するために必要です)
画面の指示に沿って対応をお願いいたします。

## リリース

作成したリリースパッケージは以下の構成になっています。

```
releasePackage
├─diff
│  ├─base
│  │  └─web
│  │      └─...
│  └─new
│      └─web
│          └─...
├─release
│  └─web
│      └─...
└─リビジョン一覧.txt
```

- `diff`
	- 変更のあったXMLが含まれています。
		- `base` に修正前、 `new` に修正後のファイルが含まれています。
		- 本番環境のファイルと3方向マージすることで差分だけを適用することができます。
- `release`
	- 上記以外の直接リリース可能なファイルが含まれています。
		- 本番環境にそのままリリースできます。
		- `scheme` 配下のSQL等もこちらに含まれています。
- `リビジョン一覧.txt`
	- パッケージに含まれているリビジョンの内容が一覧になっています。

## 開発者向け

Packman を修正した場合、以下の手順で配布してください。

- `package.json` のバージョン情報を更新
- `CHANGELOG.md` に変更内容を追記
- `npm run make` で配布用パッケージ作成
- 配布用パッケージを適当な方法で配布
