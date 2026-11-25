#!/usr/bin/env node
'use strict';

const path = require('path');

const {
  replaceAsarIcon,
} = require(path.join(__dirname, '..', 'payload', 'dist', 'hakimi-icon-manager.js'));

function parseArgs(argv) {
  const opts = {
    asarPath: null,
    iconPng: null,
    hashOut: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--asar') {
      opts.asarPath = argv[++i];
    } else if (arg === '--icon-png') {
      opts.iconPng = argv[++i];
    } else if (arg === '--hash-out') {
      opts.hashOut = argv[++i];
    } else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/replace-asar-icon.js --asar <path> --icon-png <path> [--hash-out <file>]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!opts.asarPath) throw new Error('Missing required --asar');
  if (!opts.iconPng) throw new Error('Missing required --icon-png');
  return opts;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  const res = replaceAsarIcon(opts);
  process.stdout.write(`${res.sha256}\n`);
}

module.exports = {
  replaceAsarIcon,
};
