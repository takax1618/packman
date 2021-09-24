'use strict';

const os = require("os");
const util = require('util');
const Pathname = require('path');
const fs = require('fs/promises');
const { existsSync } = require('fs');

const glob = util.promisify(require("glob"));
const Datastore = require('nedb-promises');
const parser = require('fast-xml-parser');
const ora = require('ora');
const dateFormat = require("dateformat");

const SVN = require('./svn');
const logger = require('./logger');

class Model {
	constructor(db, project, dependencies, ignoreModules) {
		this.db = db;
		this.project = project;
		this.dependencies = dependencies;
		this.ignoreModules = ignoreModules;
	}
}

Model.init = async function() {
	const db = Datastore.create(Pathname.join(__dirname, 'db'));
	
	// 設定データ読み込み
	// [TODO] 複数アカウント切り替え機能
	//        _id で一意のキーが取れる
	const project = await db.findOne({
		scheme: "project"
	});
	
	// 依存関係データ読み込み
	const dependencies = await db.find({
		scheme: "dependency"
	});
	
	// 除外モジュール読み込み
	const ignoreModules = await db.find({
		scheme: "ignore"
	});
	
	return await (new Model(db, project, dependencies, ignoreModules)).init();
};

Model.prototype.init = function(){
	this.initSVNClient();
	this.initReleaseManager();
	return this;
};

Model.prototype.initSVNClient = function(){
	if (!this.project) {
		this.svn = null;
		return this;
	}
	
	this.svn = new SVN({
		cwd: this.project.localPath,
		username: this.project.svn.user.username,
		password: this.project.svn.user.password
	});
	
	return this;
};

Model.prototype.initReleaseManager = async function(){
	if (!this.project) {
		this.releaseHistoryDB = null;
		return this;
	}
	
	this.releaseHistoryDB = Datastore.create(Pathname.join(this.project.releaseManagerPath, 'packman_release'));
	return this;
};

Model.prototype.svnCommandInstalled = async function(){
	try {
		const log = await this.svn.info();
	} catch(err) {
		// ENOENTだったらファイルなし→SVNコマンド未インストールと判断 それ以外はエラーでも気にしない
		if (err.code == `ENOENT`) return false;
	}
	
	return true;
};

Model.prototype.initProject = async function(projectName, localPath, serverPath, releaseManagerPath, svnUsername, svnPassword) {
	const config = {
		scheme: "project",
		projectName: projectName,
		localPath: localPath,
		serverPath: serverPath,
		releaseManagerPath: releaseManagerPath,
		svn: {
			user: {
				username: svnUsername,
				password: svnPassword
			},
			maxLog: 30
		}
	};
	logger.debug(`プロジェクト作成: ${JSON.stringify(config)}`);
	await this.db.insert(config);
	
	this.project = config;
};

Model.prototype.deleteProject = async function() {
	logger.info(`プロジェクト設定を削除`);
	
	await db.remove({
		scheme: 'config'
	});
	
	logger.info(`プロジェクト設定削除完了`);
};

Model.prototype.initDependencies = async function() {
	logger.info(`モジュール依存関係を収集`);
	
	logger.info(`projファイル全件取得`);
	const projFiles = 
		(await glob(Pathname.join(this.project.localPath, "src/**/ec[bB]eing.*.@(vb|cs)proj")))
		.filter(path => {
			// 不要なファイルを除外
			return !["[雛形]"].some(keyword => path.includes(keyword));
		});
	
	const assembleDependencies =  Promise.all(projFiles.map( async file => {
		logger.debug(`処理中: ${file}`);
		
		const proj = parser.parse((await fs.readFile(file, "utf-8")), {
			arrayMode: /Reference/ // "Reference" を含むノード (依存関係が記述されている箇所) は必ず配列にパースする
		});
		
		const assemblyName = proj.Project.PropertyGroup.find(el => el.AssemblyName).AssemblyName;
		
		return await this.db.insert({
			scheme: "dependency",
			name: proj.Project.PropertyGroup.find(el => el.AssemblyName).AssemblyName,
			ext: (() => {
				const outputType = proj.Project.PropertyGroup.find(el => el.AssemblyName).OutputType;
				if (outputType === 'Library') return '.dll';
				if (outputType === 'Exe') return '.exe';
				throw new Error(`${proj.Project.PropertyGroup.find(el => el.AssemblyName).AssemblyName}: Unknown output type.`);
			})(),
			referenceNames: (() => {
				const prjRefsNode = proj.Project.ItemGroup.find(el => el.ProjectReference);
				const prjRefs = prjRefsNode ? prjRefsNode.ProjectReference.map(el => el.Name) : [];
				
				const refsNode = proj.Project.ItemGroup.find(el => el.Reference);
				const refs = refsNode ? refsNode.Reference.filter(el => el.HintPath).map(el => Pathname.basename(el.HintPath, ".dll")) : [];
				
				const allRefs = [...prjRefs, ...refs];
				logger.debug(`${assemblyName} => [${allRefs.join(', ')}]`);
				
				return allRefs;
			})()
		});
	}));
	
	ora.promise(assembleDependencies, 'モジュール依存関係の収集');
	
	this.dependencies = await assembleDependencies;
};

Model.prototype.deleteDependencies = async function() {
	logger.info(`既存の依存関係を削除`);
	
	const removeTask = this.db.remove({
		scheme: "dependency"
	}, {
		multi: true
	});
	ora.promise(removeTask, '既存の依存関係を削除');
	await removeTask;
	
	this.dependencies = [];
	
	logger.info(`依存関係の削除完了`);
};

Model.prototype.resolveDependencies = async function(targets) {
	const checked = {
		all: [],
		required: []
	};
	const needsRelease = (assembly, targets, parents = []) => {
		const family = [...parents, assembly.name];
		const familyTree = family.join(' => ');
		
		// チェック済みならスキップ
		if (checked.required.includes(assembly.name)) {
			logger.debug(`${familyTree} はリリース対象であると判定済みです。`);
			return true;
		}
		if (checked.all.includes(assembly.name)) {
			logger.debug(`${familyTree} はリリース不要であると判定済みです。`);
			return false;
		}
		
		// チェック済みに追加
		checked.all.push(assembly.name);
		
		// リリース対象に含まれている場合
		if (targets.includes(assembly.name)) {
			logger.debug(`${familyTree} はリリース対象に含まれています。`);
			checked.required.push(assembly.name);
			return true;
		}
		
		// 自身の参照元のいずれかがリリース必要なら自分もリリース必要
		const ret = assembly.referenceNames.some(refName => {
			const ref = this.dependencies.find(assembly => assembly.name == refName);
			
			// 参照先の定義が存在しない (=ecBeing.Core 等閲覧権限のないモジュール) 場合はスキップ
			if (!ref) {
				return false;
			}
			return needsRelease(ref, targets, family);
		});
		
		if (ret) {
			checked.required.push(assembly.name);
			logger.debug(`${familyTree} は参照するモジュールにリリース対象が含まれているため、要リリース対象です。`);
		} else {
			logger.debug(`${familyTree} はリリース対象ではありません。`);
		}
		return ret;
	};
	return this.dependencies
		.filter(assembly => {
			return needsRelease(assembly, targets)
		})
		.map(assembly => assembly.name + assembly.ext);
};

Model.prototype.importIgnoreModules = async function(ignoreFile) {
	logger.info(`除外モジュール一覧のインポートを開始`);
	
	const buff = await fs.readFile(ignoreFile, "utf-8");
	
	// 既存の定義を削除
	await this.db.remove({
		scheme: "ignore"
	}, {
		multi: true
	});
	
	const ignoreModules = await Promise.all(
		buff
		.trim()
		.split(/\r\n|\n|\r/)
		.filter(module => module) //空行を削除
		.map( async (module) => {
			return this.db.insert({
				scheme: "ignore",
				name: module
			})
		})
	);
	
	this.ignoreModules = ignoreModules;
	
	logger.info(`除外モジュール一覧のインポートを終了`);
};

Model.prototype.formatConfig = async function() {
	logger.info(`環境設定をすべて初期化`);
	
	await this.db.remove({
	}, {
		multi: true
	});
	
	logger.info(`環境設定の初期化完了`);
};

Model.prototype.fetchCommitLogList = async function(revisions) {
	return this.svn.log({revisions: revisions});
};

Model.prototype.writeCommitLogListFile = async function(commitLogList, packDir) {
	return fs.writeFile(
		Pathname.join(packDir, 'リビジョン一覧.txt'),
		commitLogList
			.map(log => [
				`リビジョン: ${log.revision}`,
				`作者: ${log.author}`,
				`日時: ${dateFormat(new Date(log.date), 'yyyy/mm/dd HH:MM:ss')}`,
				`メッセージ:`,
				log.msg.trim(),
				`---`,
				log.paths.map(p => `${p.action} : ${p.path}`).join(os.EOL)
			].join(os.EOL)) //ログ一つぶん
			.join(os.EOL.repeat(4)) //複数ログを3行空きでまとめる
		+ os.EOL //末尾に改行を追加
	);
};

Model.prototype.initReleasePackage = async function(packDir) {
	logger.info(`リリースパッケージを初期化`);
	
	if (existsSync(packDir)) await fs.rm(packDir, {recursive: true});
	await fs.mkdir(packDir, {recursive: true});
	
	logger.info(`リリースパッケージの初期化完了`);
};

Model.prototype.classifyCommitedPaths = function(commitLogList) {
	const uniqueFileList = commitLogList.reduce((list, log) => {
		log.paths
			.filter(file => !list.some(listedFile => listedFile.action === file.action && listedFile.path === file.path))
			.forEach(file => list.push(file));
		return list;
	}, []);
	
	const classifiedPath = {
		asIs: [],
		mergeRequired: {
			added: [],
			modified: []
		},
		source: []
	};
	
	const localRoot = Pathname.basename(this.project.localPath);
	uniqueFileList.forEach(file => {
		// 削除されたファイルはリリース不要
		if (file.action == 'D') {
			logger.debug(`削除: ${JSON.stringify(file)}`);
			return;
		}
		
		// SVN上のパスなので / で分割
		const splitedPath = file.path.split('/');
		// SVNのパスからローカルのパスに変換
		const localPath = Pathname.join(this.project.localPath, ...(splitedPath.slice(splitedPath.indexOf(localRoot) + 1)));
		
		if(Pathname.extname(file.path).match(/xml/i)) {
			if (file.action == 'A') {
				logger.debug(`XML (新規): ${JSON.stringify(file)}`);
				classifiedPath.mergeRequired.added.push(localPath);
				return;
			}
			
			logger.debug(`XML (変更): ${JSON.stringify(file)}`);
			classifiedPath.mergeRequired.modified.push(localPath);
			return;
		}
		
		// SQL系のファイルは直接リリース可
		if(file.path.match(new RegExp(`/schema/`)) && !Pathname.basename(file.path).match(new RegExp(`${this.project.projectName}\.sql|ecbeing\.sql|\.xls|\.txt`, 'i')) ) {
			logger.debug(`SQL: ${JSON.stringify(file)}`);
			classifiedPath.asIs.push(localPath);
			return;
		}
		// web配下でDLL/EXE/XML以外のファイルもリリース可
		if(file.path.match(new RegExp(`/web/`)) && !Pathname.extname(file.path).match(/dll|exe|xml/i) ) {
			logger.debug(`リリース: ${JSON.stringify(file)}`);
			classifiedPath.asIs.push(localPath);
			return;
		}
		
		// vb/csファイルはビルド後にリリース可
		if(Pathname.extname(file.path).match(/vb|cs/i) ) {
			logger.debug(`ソース: ${JSON.stringify(file)}`);
			classifiedPath.source.push(localPath);
			return;
		}
		
		logger.debug(`対象外: ${JSON.stringify(file)}`);
	});
	
	classifiedPath.mergeRequired.modified = 
		classifiedPath.mergeRequired.modified
			.filter(path => {
				if (classifiedPath.mergeRequired.added.includes(path)) {
					logger.debug(`${path} は新規追加扱いとする`);
					return false;
				}
				return true;
			});
	
	return classifiedPath;
};

Model.prototype.getReleaseAssemblies = async function(sources) {
	const findProjFile = async (targetPath) => {
		const parentPath = Pathname.dirname(targetPath);
		if (parentPath === targetPath) {
			// これ以上遡れないので終了
			return;
		}
		// targetPath直下にプロジェクトファイルがあるかチェック
		const proj = (await glob(Pathname.join(targetPath, "*.@(vb|cs)proj")));
		if(proj.length) {
			return proj[0];
		};
		
		// 存在しない場合はひとつ上のディレクトリに移動して確かめる
		return await findProjFile(parentPath);
	};
	
	// ビルド必要群から対象のDLLを割り出す
	const modifiedAssemblies = [...(await sources.reduce( async (assemblyNames, sourcePath) => {
		assemblyNames = await assemblyNames; //async なのでPromiseの解決を待つ
		
		const projPath = await findProjFile(sourcePath);
		
		// prjファイルの名前とモジュール名は同一である想定
		// ファイルの中まで読みたくないのでこれで……
		return assemblyNames.add(Pathname.parse(projPath).name);
	}, new Set()))];
	
	// 対象DLLによって影響を受けるアセンブリもすべて算出して返す
	return this.resolveDependencies(modifiedAssemblies);
};

Model.prototype.makeFetchTargets = async function(releaseAssemblyNames) {
	return (await glob("!(src)/**/*.@(dll|exe)", {cwd: this.project.serverPath }))
		.map(path => Pathname.join(this.project.serverPath, path))
		.filter(path => !this.ignoreModules.some(ignore => path.match(ignore.name)))
		.filter(path => !path.match(/debug|obj|\\batch\\/i))
		.filter(path => releaseAssemblyNames.some(assemblyName => path.match(assemblyName)));
};

Model.prototype.makeReleasePackage = async function(revisions, classifiedPaths, fetchTargets, packDir) {
	const packReleaseDir  = Pathname.join(packDir, 'release');
	const packDiffDir     = Pathname.join(packDir, 'diff');
	const packDiffBaseDir = Pathname.join(packDiffDir, 'base');
	const packDiffNewDir  = Pathname.join(packDiffDir, 'new');
	
	await Promise.all([
		// 要ビルド対象はサーバから最新版を取ってくる
		this.fetchBuildedAssemblies(fetchTargets, packReleaseDir),
		// それ以外はリビジョン指定でエクスポートする
		this.exportSVN(Math.max(...revisions),     classifiedPaths.asIs,                                                                packReleaseDir),
		this.exportSVN(Math.max(...revisions),     [...classifiedPaths.mergeRequired.added, ...classifiedPaths.mergeRequired.modified], packDiffNewDir),
		this.exportSVN(Math.min(...revisions) - 1, classifiedPaths.mergeRequired.modified,                                              packDiffBaseDir)
	]);
	
	return {
		packDir: packDir,
		packReleaseDir: packReleaseDir,
		packDiffDir: packDiffDir,
		packDiffBaseDir: packDiffBaseDir,
		packDiffNewDir: packDiffNewDir
	};
};

Model.prototype.fetchBuildedAssemblies = async function(fetchTargets, destDir) {
	await Promise.all(fetchTargets
		.map( async (src) => {
			const dest = Pathname.join(destDir, src.replace(this.project.serverPath, ''));
			
			if (!existsSync(Pathname.dirname(dest))) await fs.mkdir(Pathname.dirname(dest), {recursive: true});
			
			await fs.copyFile(src, dest);
			
			return dest;
		})
	);
};

Model.prototype.exportSVN = async function(revision, localPaths, destDir) {
	return await Promise.all(localPaths.map( async (path) => {
		const packPath = Pathname.dirname(path.replace(this.project.localPath, destDir));
		
		if (!existsSync(packPath)) await fs.mkdir(packPath, {recursive: true});
		
		await this.svn.export(path, {
			revision: revision,
			to: packPath
		});
	}));
};

Model.prototype.findAllPackedFiles = async function(releasePackage) {
	return [
		...(await glob("**/*", {cwd: releasePackage.packReleaseDir, nodir: true })),
		...(await glob("**/*", {cwd: releasePackage.packDiffNewDir, nodir: true }))
	].sort();
};

Model.prototype.writePackedFiles = async function(packedFiles, packDir) {
	return fs.writeFile(
		Pathname.join(packDir, 'リリースモジュール一覧.tsv'),
		packedFiles
		.map(path => `${Pathname.dirname(path)}\t${Pathname.basename(path)}\n`)
		.join('')
	);
};

Model.prototype.updateReleaseHistory = async function() {
	logger.info(`リリース履歴の最新化`);
	
	logger.info(`最新のコミットを取得`);
	const commits = await this.fetchLatestCommits();
	commits.forEach(commit => logger.debug(commit));
	
	await this.insertReleaseHistory(commits);
};

Model.prototype.fetchLatestCommits = async function() {
	return await this.svn.log({
		revisions: {
			from: "HEAD",
			to: 1
		},
		limit: this.project.svn.maxLog
	});
};

Model.prototype.fetchUnreleasedCommits = async function() {
	const commits = await this.fetchLatestCommits();
	
	const unreleasedRevisions = 
		(await this.fetchReleaseHistory())
			.filter(history => !history.releasedAt)
			.map(history => history.revision);
	
	return commits.filter(commit => unreleasedRevisions.includes(commit.revision));
};

Model.prototype.insertReleaseHistory = async function(commitLogs) {
	logger.info(`リリース履歴追加`);
	const savedRevisions = (await this.fetchReleaseHistory()).map(history => history.revision);
	
	await Promise.all(
		commitLogs
		.filter(log => !savedRevisions.includes(log.revision))
		.map(async (log) => {
			logger.debug(`リリース履歴新規追加: ${JSON.stringify(log)}`);
			
			await this.releaseHistoryDB.insert({
				scheme: "history",
				revision: log.revision,
				summary: log.msg.split(/\n/)[0],
				releasedAt: null
			})
		})
	);
};

Model.prototype.fetchReleaseHistory = async function() {
	logger.info(`リリース履歴を取得`);
	const releaseHistory = await this.releaseHistoryDB.find({
		scheme: "history"
	}).sort({revision: -1});
	releaseHistory.forEach(rec => logger.debug(rec));
	return releaseHistory;
};

Model.prototype.updateReleaseDate = async function(revisions) {
	logger.info(`リリース日更新`);
	if (revisions && revisions.length) {
		revisions.forEach(rev => logger.debug(`リビジョン ${rev}`));
	} else {
		logger.debug(`対象なし`);
	}
	
	return await this.releaseHistoryDB.update({
		scheme: "history",
		revision: {$in: [...revisions]}
	}, {
		$set: {releasedAt: Date.now()}
	}, {
		multi: true
	});
};

Model.prototype.clearReleaseDate = async function(revisions) {
	logger.info(`リリース日削除`);
	if (revisions && revisions.length) {
		revisions.forEach(rev => logger.debug(`リビジョン ${rev}`));
	} else {
		logger.debug(`対象なし`);
	}
	
	return await this.releaseHistoryDB.update({
		scheme: "history",
		revision: {$in: [...revisions]}
	}, {
		$set: {releasedAt: null}
	}, {
		multi: true
	});
};

module.exports = Model;
