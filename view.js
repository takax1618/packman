'use strict';

const os = require("os");
const util = require('util');
const Pathname = require('path');
const { existsSync } = require('fs');

const colors = require('colors');
const { prompt, Select } = require('enquirer');
const figlet = require("figlet");
const ora = require('ora');
const dateFormat = require("dateformat");
const dotenv = require('dotenv');

const logger = require('./logger');

dotenv.config();

class View {
}

View.prototype.showTitle = function() {
	console.log(figlet.textSync("Packman", {
		font: 'Univers'
	}));
}

View.prototype.exitByNoSvnTools = function() {
	console.log("SVN Command Line Tools のインストールが確認できなかったため、コマンドを終了します。");
	console.log("README.txt を参照して必要なツールをインストールしてください。");
}

View.prototype.inputProject = async function() {
	while (true) {
		console.log([
			"=".repeat(100),
			"プロジェクト設定",
			"=".repeat(100)
		].join(os.EOL).green);
		
		const projectName = (await prompt({
			type: 'input',
			name: 'projectName',
			message: `プロジェクト名 (例: "DC")`,
			validate: (value) => {
				if (value === "") return "プロジェクト名は必須項目です。再度入力してください。".red;
				return true;
			}
		})).projectName;
		
		// dotenvで宣言されてなければいったん空文字列にする
		process.env.LOCAL_SRC_ROOT = process.env.LOCAL_SRC_ROOT || "";
		process.env.REMOTE_SRC_ROOT = process.env.REMOTE_SRC_ROOT || "";
		process.env.RELEASE_MANAGER_DIR = process.env.RELEASE_MANAGER_DIR || "";
		
		const localPath = (await prompt({
			type: 'input',
			name: 'localPath',
			message: `ローカルディレクトリ`,
			initial: process.env.LOCAL_SRC_ROOT.replace('${PRJ_DIR}', projectName.toLowerCase()),
			validate: (value) => {
				if (!value.match(/phase\d(\\)?$/)) return "ディレクトリはphaseN (web や src があるところ) を指定してください。";
				if (!existsSync(value)) return "指定されたディレクトリが存在しません。";
				return true;
			},
			result: (value) => {
				if (value.endsWith(Pathname.sep)) value = value.slice(0, Pathname.sep.length);
				return value; 
			}
		})).localPath;
		
		const serverPath = (await prompt({
			type: 'input',
			name: 'serverPath',
			message: `サーバ環境`,
			initial: process.env.REMOTE_SRC_ROOT.replace('${PRJ_DIR}', projectName.toLowerCase()),
			validate: (value) => {
				if (!value.match(/phase\d(\\)?$/)) return "ディレクトリはphaseN (web や src があるところ) を指定してください。";
				if (!existsSync(value)) return "指定されたディレクトリが存在しません。";
				return true;
			},
			result: (value) => {
				if (value.endsWith(Pathname.sep)) value = value.slice(0, Pathname.sep.length);
				return value; 
			},
			footer: `(ここで指定したパスからビルド済モジュールを収集します)`
		})).serverPath;
		
		const releaseManagerPath = (await prompt({
			type: 'input',
			name: 'releaseManagerPath',
			message: `リリース管理ファイル保存用ディレクトリ`,
			initial: process.env.RELEASE_MANAGER_DIR.replace('${PRJ_DIR}', projectName.toLowerCase()),
			validate: (value) => {
				if (!existsSync(value)) return "指定されたディレクトリが存在しません。";
				return true;
			},
			result: (value) => {
				if (value.endsWith(Pathname.sep)) value = value.slice(0, Pathname.sep.length);
				return value; 
			},
			footer: `(指定されたディレクトリにリリース履歴を保存します。ネットワークパスを指定するとリリース履歴を共有できます。)`
		})).releaseManagerPath;
		
		const svnUsername = (await prompt({
			type: 'input',
			name: 'username',
			message: `SVNユーザー名`,
			validate: (value) => {
				if (value === "") return "ユーザー名は必須項目です。再度入力してください。".red;
				return true;
			}
		})).username;

		const svnPassword = (await prompt({
			type: 'input',
			name: 'password',
			message: `SVNパスワード`,
			validate: (value) => {
				if (value === "") return "パスワードは必須項目です。再度入力してください。".red;
				return true;
			}
		})).password;
		
		if ((await prompt({
			type: 'confirm',
			name: 'ok',
			message: '以上の内容でよろしいですか?'
		})).ok) {
			return [projectName, localPath, serverPath, releaseManagerPath, svnUsername, svnPassword];
		}
	}
};

View.prototype.showProject = function (config) {
	console.log([
		"=".repeat(100),
		"    プロジェクト名      : " + config.projectName.green,
		"    ローカルディレクトリ: " + config.localPath.green,
		"    ビルド環境          : " + config.serverPath.green,
		"    リリース管理        : " + config.releaseManagerPath.green,
		"    SVN: ",
		"        ユーザー名: " + config.svn.user.username.green,
		"        パスワード: " + "****".green,
		"=".repeat(100)
	].join(os.EOL));
};

View.prototype.confirmDeleteProject = async function () {
	return (await prompt({
		type: 'toggle',
		name: 'go',
		initial: false,
		message: 'プロジェクト設定を削除します。本当によろしいですか?',
		enabled: `はい`,
		disabled: `いいえ`
	})).go;
};

View.prototype.confirmInitDependencies = async function () {
	return (await prompt({
		type: 'confirm',
		initial: 'true',
		name: 'ok',
		message: 'ビルド依存関係データを作成します。処理は数秒で終わります。'
	})).ok;
};

View.prototype.exitByNoDependencies = function() {
	console.log(`モジュール情報がないため、依存関係の解決ができません。コマンドを終了します。`);
};

View.prototype.continueWithExistingDependencies = function() {
	console.log(`依存関係情報はリセットせずにそのまま続けます。`);
};

View.prototype.confirmImportIgnoreModules = async function (ignoreFile) {
	console.log([
		`除外モジュール一覧をファイルからインポートします。`,
		`利用していない標準バッチが存在する場合などに利用してください。`,
		`${ignoreFile} にリリースしないモジュール名を一行ずつ記載してください。`,
		`記載された内容を含むパスはリリースパッケージから除外されます。`
	].join(os.EOL));
	
	return (await prompt({
		type: 'toggle',
		name: 'go',
		message: `インポート`,
		enabled: 'する',
		disabled: 'しない'
	})).go;
};

View.prototype.confirmFormat = async function () {
	return (await prompt({
		type: 'toggle',
		name: 'go',
		initial: false,
		message: 'すべての設定を初期化します。本当によろしいですか?',
		enabled: `はい`,
		disabled: `いいえ`
	})).go;
};

View.prototype.selectMenu = async function(commands) {
	const menuPrompt = new Select({
		name: 'cmd',
		message: '実行する内容を選択してください。',
		choices: commands
	});
	
	// そのままだと name の値が返ってしまうため、value の関数を返すようにする
	const cmdName = await menuPrompt.run();
	logger.info(`実行 [${cmdName}]`);
	
	return menuPrompt.choices.find(ch => ch.name == cmdName).value;
};

View.prototype.inputRevisions = async function() {
	return (await prompt({
		type: 'list',
		name: 'revisions',
		message: 'リリースするリビジョン番号を指定してください。(カンマ区切りで複数入力可)'
	})).revisions.map(r => parseInt(r));
};

View.prototype.revisionEmpty = function() {
	console.log('リビジョン番号を入力してください。'.yellow);
};

View.prototype.selectRevisions = async function(commitLogs) {
	return (await prompt({
		type: 'multiselect',
		name: 'revisions',
		message: 'リリースするリビジョンを選択してください。',
		choices: commitLogs.map(log => {
			const date = new Date(log.date);
			return {
				value: log.revision,
				message: `${log.revision} (${dateFormat(date, 'yyyy/mm/dd HH:MM:ss')}): ${log.msg.split(/\n/)[0]} [by ${log.author}]`
			};
		}),
		hint: '(Space で選択、Enterで確定)'
	})).revisions;
};

View.prototype.revisionNotSelected = function() {
	console.log('リビジョンが選択されていません。'.yellow);
};

View.prototype.initReleasePackageFailed = function() {
	console.log('リリースパッケージの初期化に失敗しました。'.yellow);
	console.log('パッケージ内のファイルを開いたままにしていないか確認し、再度実行してください。');
};

View.prototype.packingSucceeded = function(packDir) {
	console.log('完了!'.green.bold);
	console.log('以下のパスにリリースパッケージをまとめました。内容を確認してください。');
	console.log(packDir);
};

View.prototype.packingFailed = function(err) {
	console.log([
		`リリースパッケージ作成中に以下のエラーが発生しました。`,
		`エラー内容を確認し、可能であれば原因を排除した上で再度実行してください。`,
		`----`,
		err.message.yellow,
		`----`,
		`(不要なモジュールに関するエラーの場合、メインメニューから除外モジュールを指定することもできます)`.gray
	].join(os.EOL));
};

View.prototype.selectReleasedRevisions = async function(releaseHistory) {
	const header = `Revision Release Date        Summary`;
	const format = (strings, revision, releaseDate, summary) => {
		return `${revision.toString().padEnd(8)} ${releaseDate.toString().padEnd(19)} ${summary}`;
	};
	return (await prompt({
		type: 'multiselect',
		name: 'revisions',
		message: 'リリース済みのリビジョンにチェックを入れてください。',
		initial: releaseHistory.filter(record => record.releasedAt).map(record => record.revision),
		choices: [
			{message: header, role: 'separator'},
			...(releaseHistory.map(record => {
				if (record.releasedAt) {
					return {
						message: format `${record.revision} ${dateFormat(record.releasedAt, 'yyyy/mm/dd HH:MM:ss')} ${record.summary}`,
						name: record.revision
					};
				}
				return {
					message: format `${record.revision} ${""} ${record.summary}`,
					name: record.revision
				};
			}))
		],
		hint: '(Space で選択、Enterで確定)'
	})).revisions;
};

View.prototype.confirmConflicts = async function (conflicts) {
	if (!conflicts.length) return true;
	
	console.log(`一部モジュールはリリースパッケージ外の下記リビジョンで更新されています。`.yellow.dim);
	
	conflicts.forEach(conflict => {
		console.log(`[${conflict.revision}] ${conflict.summary}`);
		console.log([...conflict.assemblyNames].map(assembly => `    ${assembly}`).join(os.EOL));
	});
	
	return (await prompt({
		type: 'toggle',
		name: 'go',
		initial: false,
		message: 'リリースパッケージの作成を続けますか?',
		enabled: `続ける`,
		disabled: `やめる`
	})).go;
};

module.exports = View;
