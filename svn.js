'use strict';

const spawn = require('child_process').spawn;
const parser = require('fast-xml-parser');

class SVN {
	constructor(options = {}){
		this.cmd = 'svn';
		this.options = Object.assign({
		}, options);
	}
}

SVN.prototype.exec = async function (subCmd, options = {}) {
	if (!options.cwd) options.cwd = this.options.cwd || undefined;
	
	if (options.silent == null) options.silent = true; //標準出力には基本なにも出さない
	
	const outputData = [];
	const errorData = [];
	
	return new Promise((resolve, reject) => {
		const s = spawn(this.cmd, this.makeSVNParams(subCmd, options), {cwd: options.cwd});
		
		//spawn 自体が死んだとき
		s.on('error', reject);
		
		// spawn したコマンドが終了したとき
		s.on('close', (code, signal) => {
			const outputResult = outputData.join("");
			const errorResult = errorData.join("");
			
			if (code === 0 && errorResult === "") {
				resolve(outputResult);
				return;
			}
			const svnErrorCode = errorResult.match(/(?<=svn: )E\d*/);
			const e = new Error(errorResult);
			e.code = svnErrorCode || code;
			e.output = outputResult;
			reject(e);
		});
		
		s.stdout.setEncoding('utf-8');
		s.stdout.on('data', function(data) {
			if (!options.silent) {
				process.stdout.write(data);
			}
			outputData.push(data);
		});
		s.stderr.setEncoding('utf-8');
		s.stderr.on('data', function(data) {
			if (!options.silent) {
				process.stderr.write(data);
			}
			errorData.push(data);
		});
	});
};

SVN.prototype.makeSVNParams = function (subCmd, params) {
	let svnParams = [subCmd];
	let svnURLParams = [];
	let svnPathParams = [];
	let svnDestParams = [];
	for (const key in params) {
		let val = params[key];
		switch (key.toString()) {
			case "verbose": {
				if (val) svnParams.push("-v");
				break;
			}
			case "xml": {
				if (val) svnParams.push("--xml");
				break;
			}
			case "revision": 
			case "revisions": {
				const revs = [];
				
				if (Number.isInteger(val)) revs.push(val);
				if (typeof val === 'string') revs.push(val);
				if (val.from) revs.push(val.from);
				if (val.to) revs.push(val.to);
				
				if (revs.length) svnParams = [...svnParams, '-r', revs.join(':')];
				break;
			}
			case "username": {
				if (val) svnParams = [...svnParams, "--username", val];
				break;
			}
			case "password": {
				if (val) svnParams = [...svnParams, "--password", val];
				break;
			}
			case "limit": {
				if (Number.isInteger(val)) svnParams = [...svnParams, '-l', val];
				break;
			}
			case "incremental": {
				if (val) svnParams.push("--incremental");
				break;
			}
			case "url": {
				svnURLParams.push(val);
				break;
			}
			case "path": {
				if (!Array.isArray(val)) val = [val];
				svnPathParams = [...svnPathParams, ...val];
				break;
			}
			case "to": {
				svnDestParams.push(val);
				break;
			}
		}
	}
	return [...svnParams, ...svnURLParams, ...svnPathParams, ...svnDestParams];
};

SVN.prototype.log = async function (options) {
	// revisions が配列の場合、リビジョン番号の配列であるとみなし、
	// 指定されたリビジョンを一つずつ取得してからまとめて返す
	if (Array.isArray(options.revisions)) {
		return Promise.all(options.revisions.map(async (revision) => {
			return (await this.log(
				// オプションはそのまま、リビジョン番号だけ指定の一つに変更
				Object.assign(options, {revisions: revision})
			))[0];
		}));
	}
	
	// デフォルト値設定
	options = Object.assign({
		verbose: true
	}, options);
	options.xml = true; // パースするのでXMLは必須
	
	const log = await this.exec("log", options);
	
	// XML => JSON に変換して、使いやすい形に整形してから返す
	return parser.parse(log, {
		arrayMode: true,
		attributeNamePrefix: "",
		ignoreAttributes: false,
		parseAttributeValue : true,
		textNodeName : "_"
	})
	.log[0]
	.logentry
	.map(j => {
		if (!j.paths) return j;
		
		j.paths = j.paths[0].path.map(p => {
			return {
				path: p._,
				action: p.action,
				propMods: p['prop-mods'],
				textMods: p['text-mods'],
				kind: p.kind
			};
		});
		return j;
	});
};

SVN.prototype.export = async function (path, options) {
	options.path = path;
	await this.exec("export", options);
};

SVN.prototype.info = async function (path, options) {
	const info = await this.exec("info");
	
	return parser.parse(info, {
		attributeNamePrefix: "",
		ignoreAttributes: false,
		parseAttributeValue : true,
		textNodeName : "_"
	});
};

module.exports = SVN;
