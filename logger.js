'use strict';

const winston = require('winston');
const format = winston.format;
const dateFormat = require("dateformat");

const logger = winston.createLogger({
	level: 'info',
	format: format.combine(
		(format((log, opts) => {
			log.time = dateFormat(Date.now(), 'yyyy/mm/dd HH:MM:ss');
			return log;
		}))(),
		(format((log, opts) => {
			if (typeof log.message === 'object') {
				log.message = JSON.stringify(log.message);
			}
			return log;
		}))(),
		format.errors({stack: true}),
		format.printf(log => {
			const tmpl = `time:${log.time}\tlevel:${log.level}\tmessage:${log.message}`;
			if (log.stack) {
				return `${tmpl}\tstack:${log.stack.split('\n').map(s => s.trim()).join(' ')}`
			};
			return tmpl;
		})
	),
	transports: [
		new winston.transports.File({
			filename: `${dateFormat(Date.now(), 'yyyy-mm-dd_HH-MM-ss')}.log`
		})
	]
});

module.exports = logger;
