const Pathname = require('path');
const packlist = require('npm-packlist');
const fs = require('fs/promises');
const { existsSync } = require('fs');

(async () => {
	const dist = Pathname.join(__dirname, `${process.env.npm_package_name}-${process.env.npm_package_version}`);
	const pack = Pathname.join(dist, `packman`);
	if (existsSync(dist)) await fs.rm(dist, {recursive: true});
	
	const files = await packlist({path: __dirname});
	await Promise.all(files.map(async file => {
		const src = Pathname.join(__dirname, file);
		const dest = Pathname.join(pack, file);
		const destDir = Pathname.dirname(dest);
		
		if (!existsSync(destDir)) await fs.mkdir(destDir, {recursive: true});
		await fs.copyFile(src, dest);
	}));
	
	console.log(`Completed. (${dist})`);
})();
