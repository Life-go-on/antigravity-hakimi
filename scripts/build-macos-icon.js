#!/usr/bin/env node
'use strict';

const path = require('path');

const {
  ICONSET_SPECS,
  buildMacosIcon,
} = require(path.join(__dirname, '..', 'payload', 'dist', 'hakimi-icon-manager.js'));

function parseArgs(argv) {
  const opts = {
    inputPath: null,
    outIcnsPath: null,
    outPngPath: null,
    rawIcon: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input') {
      opts.inputPath = argv[++i];
    } else if (arg === '--out-icns') {
      opts.outIcnsPath = argv[++i];
    } else if (arg === '--out-png') {
      opts.outPngPath = argv[++i];
    } else if (arg === '--no-mask') {
      opts.rawIcon = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log(
        'Usage: node scripts/build-macos-icon.js --input <path> --out-icns <path> --out-png <path> [--no-mask]'
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!opts.inputPath) throw new Error('Missing required --input');
  if (!opts.outIcnsPath) throw new Error('Missing required --out-icns');
  if (!opts.outPngPath) throw new Error('Missing required --out-png');
  return opts;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  const res = buildMacosIcon(opts);
  process.stdout.write(`${JSON.stringify(res)}\n`);
}

module.exports = {
  ICONSET_SPECS,
  buildMacosIcon,
};
