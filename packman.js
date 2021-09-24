'use strict';

const os = require("os");
const Pathname = require('path');

const colors = require('colors');
const ora = require('ora');

const View = require('./view');
const Model = require('./model');
const logger = require('./logger');

const makeReleasePackage = async (view, model, releaseRevisions, unreleasedRevisions) => {
	logger.info(`対象リビジョン: ${releaseRevisions.join(', ')}`);
	
	const packDir = Pathname.join(__dirname, `releasePackage`);
	
	try {
		await model.initReleasePackage(packDir);
	} catch(err) {
		logger.error(err);
		view.initReleasePackageFailed();
		return false;
	}
	
	const commitLogList = model.fetchCommitLogList(releaseRevisions);
	ora.promise(commitLogList, '対象コミット情報を取得');
	
	const writeCommitLogListFile = model.writeCommitLogListFile(await commitLogList, packDir);
	ora.promise(writeCommitLogListFile, 'リビジョン一覧.txt を作成');
	await writeCommitLogListFile;
	
	const classifiedPaths = model.classifyCommitedPaths(await commitLogList);
	
	const releaseAssemblies = await model.getReleaseAssemblies(classifiedPaths.source);
	
	if (unreleasedRevisions.length) {
		logger.info(`未リリースリビジョンとのコンフリクト判定 (対象: ${unreleasedRevisions.join(', ')})`);
		
		const unreleasedCommitList = model.fetchCommitLogList(unreleasedRevisions);
		ora.promise(unreleasedCommitList, '未リリースのコミット情報を取得');
		
		const conflicts = [];
		await Promise.all((await unreleasedCommitList).map( async (commit) => {
			const unreleasedSources = model.classifyCommitedPaths([commit]).source;
			if (!unreleasedSources.length) {
				logger.info(`${commit.revision} はソースファイルを含まないためコンフリクト判定をスキップ`);
				return;
			}
			const assemblies = await model.getReleaseAssemblies(unreleasedSources);
			assemblies
				.filter(assembly => releaseAssemblies.includes(assembly))
				.forEach(assemblyName => {
					const conf = conflicts.find(conflict => conflict.revision === commit.revision);
					
					if (!conf) {
						conflicts.push({
							revision: commit.revision,
							summary: commit.msg.split(/\n/)[0],
							assemblyNames: new Set([assemblyName])
						});
						return;
					}
					
					conf.assemblyNames.add(assemblyName);
				});
		}));
		
		const confirmed = await view.confirmConflicts(conflicts);
		if (!confirmed) return false;
	}
	
	const fetchTargets = model.makeFetchTargets(releaseAssemblies);
	ora.promise(fetchTargets, 'モジュール一覧を取得');
	await fetchTargets;
	
	try {
		const releasePackage = model.makeReleasePackage(releaseRevisions, classifiedPaths, await fetchTargets, packDir);
		ora.promise(releasePackage, 'リリースパッケージを作成');
		await releasePackage;
		
		const packedFiles = await model.findAllPackedFiles(await releasePackage);
		await model.writePackedFiles(packedFiles, packDir);
		
		await model.updateReleaseDate(releaseRevisions);

		view.packingSucceeded(packDir);
	} catch (err) {
		logger.error(err);
		view.packingFailed(err);
	}
	return true;
};

const cmdPackByCommitLog = async (view, model) => {
	const commitLogs = await model.fetchUnreleasedCommits();
	const selectedRevisions = await view.selectRevisions(commitLogs);
	if (!selectedRevisions.length) {
		view.revisionNotSelected();
		return false;
	}
	const unreleasedRevisions = commitLogs.map(log => log.revision).filter(rev => !selectedRevisions.includes(rev));
	
	await makeReleasePackage(view, model, selectedRevisions, unreleasedRevisions);
	
	return true;
};

const cmdPackByRevision = async (view, model) => {
	const specifiedRevisions = await view.inputRevisions();
	if (!specifiedRevisions.length) {
		view.revisionEmpty();
		return false;
	}
	
	const unreleasedRevisions = (await model.fetchUnreleasedCommits()).map(log => log.revision).filter(rev => !specifiedRevisions.includes(rev));
	
	//const specifiedRevisions = [177673, 177637];
	//const specifiedRevisions = [177673, 177637, 128875];
	
	await makeReleasePackage(view, model, specifiedRevisions, unreleasedRevisions);
	
	return true;
};

const cmdDeleteProject = async (view, model) => {
	if (!(await view.confirmDeleteProject())) {
		// プロジェクト設定を削除しない
		return false;
	}
	
	await model.deleteProject();
	
	return true;
};

const cmdResetDependencies = async (view, model) => {
	if (!(await view.confirmInitDependencies())) {
		// 依存関係をリセットしない
		view.continueWithExistingDependencies();
		return false;
	}
	
	await model.deleteDependencies();
	await model.initDependencies();
	
	// 依存関係リセット後は exit せずメニューに戻る
	return false;
};

const cmdImportIgnoreModules = async (view, model) => {
	const ignoreFile = Pathname.join(__dirname, '.packIgnore');

	if (!(await view.confirmImportIgnoreModules(ignoreFile))) {
		// 除外モジュール一覧をインポートしない
		return false;
	}
	
	try {
		await model.importIgnoreModules(ignoreFile);
	} catch (err) {
		if (err.code == 'ENOENT' && err.errno == -4058) {
			console.log(`ファイルを読み込めませんでした。${ignoreFile} が存在することを確認してください。`);
			return false;
		}
		throw err;
	}
	
	// 除外モジュールインポート後は exit せずメニューに戻る
	return false;
};

const cmdResetReleaseHistory = async (view, model) => {
	const releaseHistory = await model.fetchReleaseHistory();
	const checkedRevisions = await view.selectReleasedRevisions(releaseHistory);
	
	logger.debug(`リリース済とするリビジョン: [${checkedRevisions.join()}]`);
	
	// 履歴では未リリースだけどチェックされた→現在時刻でリリース済みにする
	await model.updateReleaseDate(
		releaseHistory
			.filter(rec => !rec.releasedAt)
			.map(rec => rec.revision)
			.filter(rev => checkedRevisions.includes(rev))
	);
	
	// 履歴ではリリース済みだけどチェック入ってない→リリース時刻を取り消す
	await model.clearReleaseDate(
		releaseHistory
			.filter(rec => rec.releasedAt)
			.map(rec => rec.revision)
			.filter(rev => !checkedRevisions.includes(rev))
	);
	return false;
};

const cmdFormat = async (view, model) => {
	if (!(await view.confirmFormat())) {
		// 初期化しない場合
		return false;
	}
	await model.formatConfig();
	return true;
};

const cmdExit = async (view, model) => {
	return true;
};

(async () => {
	try {
		logger.info('Packman 開始');
		
		const view = new View();
		view.showTitle();
		
		const model = await Model.init();
		
		if (model.project != null) {
			view.showProject(model.project);
		} else {
			const inputs = await view.inputProject();
			await model.initProject(...inputs);
			model.init();
		}
		
		if (!(await model.svnCommandInstalled())) {
			logger.info(`SVNコマンドラインツールのインストールが確認できなかったため終了`);
			view.exitByNoSvnTools();
			return;
		}
		
		const spinner = ora(`リリース履歴を初期化`).start();
		const latestCommits = await model.updateReleaseHistory();
		spinner.stop();
		
		// 依存関係データが存在しない場合は新規作成
		if (!model.dependencies.length) {
			logger.info(`依存関係データを新規作成`);
			if (await view.confirmInitDependencies()) {
				await model.initDependencies();
			} else {
				logger.info(`依存関係データの作成が拒否されたため終了`);
				view.exitByNoDependencies();
				return;
			}
		}
		
		while (true) {
			logger.info(`メインメニュー起動`);
			
			const cmd = await view.selectMenu([
				{message: "リリースパッケージ作成".white, role: 'separator', choices: [
					{message: "コミットログから選ぶ", name: "リリースパッケージ作成 (コミットログから選ぶ)", value: cmdPackByCommitLog },
					{message: "リビジョン番号で指定する", name: "リリースパッケージ作成 (リビジョン番号で指定する)", value: cmdPackByRevision },
				]},
				{role: 'separator', message: '-'.repeat(40)},
				{message: "環境設定".white, role: 'separator', choices: [
					{name: "プロジェクト設定の削除", value: cmdDeleteProject },
					{name: "モジュール依存関係の再設定", value: cmdResetDependencies },
					{name: "除外モジュール一覧のインポート", value: cmdImportIgnoreModules },
					{name: "リリース履歴確認・再設定", value: cmdResetReleaseHistory },
					{name: "設定の初期化", value: cmdFormat },
				]},
				{role: 'separator', message: '-'.repeat(40)},
				{name: "終了", value: () => true }
			]);
			
			const exit = await cmd(view, model);
			
			if (exit) return;
			continue;
		}
	} catch(err) {
		logger.error(err);
	} finally {
		logger.info('Packman 終了');
	}
	return;
})();
