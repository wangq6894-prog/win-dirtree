#!/usr/bin/env node
'use strict';

// dirtree.js - 把盘符或文件夹里的所有内容画成树状图，写进一个文本文件

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const POOL_SIZE = '64';

if (!process.env.UV_THREADPOOL_SIZE) {
  const restarted = spawnSync(process.execPath, process.argv.slice(1), {
    env: { ...process.env, UV_THREADPOOL_SIZE: POOL_SIZE },
    stdio: 'inherit',
  });
  process.exit(restarted.status === null ? 1 : restarted.status);
}

process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || POOL_SIZE;

const fsp = fs.promises;

const SEP = path.sep;
const PIPE = '│   ';
const TEE = '├── ';
const ELBOW = '└── ';
const BLANK = '    ';
const FLUSH_THRESHOLD = 4 * 1024 * 1024;
const DEFAULT_JOBS = 32;
const MAX_JOBS = 512;
const LONG_PATH_THRESHOLD = 250;

const HELP = `用法：node dirtree.js <盘符或文件夹> [输出文件] [选项]

把指定位置的所有文件和文件夹画成树状图，存进一个文本文件。

例子：
  node dirtree.js D:                 扫 D 盘 → D:\\D_drive_tree.txt
  node dirtree.js D:\\照片 相册.txt   扫文件夹 → 相册.txt
  node dirtree.js D: --depth 2       只展开两层

选项：
  -d, --depth N     只展开 N 层（默认全部展开）
  -j, --jobs N      同时处理的文件夹数（默认 ${DEFAULT_JOBS}）
      --elevate     以管理员身份运行（会弹 UAC）
      --no-progress 不显示扫描进度
  -h, --help        显示这段帮助

说明：
  · 目录名末尾带分隔符，文件不带；目录排在文件前面，各自按名称排序
  · 符号链接不跟随，只标注 [link]；没权限的目录标注 [无法访问]
  · 结果默认存在被扫描的盘/文件夹里；那里写不进去会问你是否用管理员
    身份重跑，也会告诉你文件最终存到了哪里
`;

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}

function printHelp(code) {
  process.stdout.write(HELP);
  process.exit(code);
}

function parsePositiveInt(text, name, max) {
  if (!/^\d+$/.test(text)) fail(`错误：${name} 需要正整数，收到 "${text}"`);
  const value = Number(text);
  if (value < 1) fail(`错误：${name} 至少为 1`);
  if (max !== undefined && value > max) fail(`错误：${name} 最大 ${max}`);
  return value;
}

function parseDepth(text) {
  if (!/^\d+$/.test(text)) fail(`错误：--depth 需要 0 或正整数，收到 "${text}"`);
  return Number(text);
}

function parseArgs(argv) {
  const positional = [];
  const options = {
    depth: Infinity,
    jobs: DEFAULT_JOBS,
    elevate: false,
    elevated: false,
    progress: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) fail(`错误：${arg} 后面缺少数值`);
      return next;
    };

    if (arg === '-h' || arg === '--help') {
      printHelp(0);
    } else if (arg === '--elevate') {
      options.elevate = true;
    } else if (arg === '--_elevated') {
      options.elevated = true;
    } else if (arg === '--no-progress') {
      options.progress = false;
    } else if (arg === '-d' || arg === '--depth') {
      options.depth = parseDepth(value());
    } else if (arg.startsWith('--depth=')) {
      options.depth = parseDepth(arg.slice('--depth='.length));
    } else if (/^-d\d+$/.test(arg)) {
      options.depth = parseDepth(arg.slice(2));
    } else if (arg === '-j' || arg === '--jobs') {
      options.jobs = parsePositiveInt(value(), '--jobs', MAX_JOBS);
    } else if (arg.startsWith('--jobs=')) {
      options.jobs = parsePositiveInt(arg.slice('--jobs='.length), '--jobs', MAX_JOBS);
    } else if (/^-j\d+$/.test(arg)) {
      options.jobs = parsePositiveInt(arg.slice(2), '--jobs', MAX_JOBS);
    } else if (arg.length > 1 && arg.startsWith('-')) {
      fail(`错误：未知选项 "${arg}"（用 -h 查看用法）`);
    } else {
      positional.push(arg);
    }
  }

  return { positional, options };
}

function normalizeRoot(input) {
  if (process.platform === 'win32' && /^[A-Za-z]:$/.test(input)) return input + SEP;
  return path.resolve(input);
}

function toLongPath(target) {
  if (process.platform !== 'win32') return target;
  if (target.startsWith('\\\\?\\')) return target;
  if (target.length < LONG_PATH_THRESHOLD) return target;
  if (/^[A-Za-z]:/.test(target)) return '\\\\?\\' + target;
  if (target.startsWith('\\\\')) return '\\\\?\\UNC\\' + target.slice(2);
  return target;
}

function joinChild(parent, name) {
  return parent.endsWith(SEP) ? parent + name : parent + SEP + name;
}

function defaultOutPath(root) {
  const drive = /^([A-Za-z]):\\?$/.exec(root);
  const base = drive ? `${drive[1]}_drive` : path.basename(root) || 'root';
  return joinChild(root, `${base}_tree.txt`);
}

function compareEntries(a, b) {
  const aRank = a.isDirectory() ? 0 : 1;
  const bRank = b.isDirectory() ? 0 : 1;
  if (aRank !== bRank) return aRank - bRank;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

function sameText(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function tryOpenFile(file) {
  try {
    return { fd: fs.openSync(file, 'w'), file };
  } catch (err) {
    return { error: err };
  }
}

function buildOpenError(outFile, err, userTarget, userOut) {
  const script = path.basename(process.argv[1] || 'dirtree.js');
  const dir = path.dirname(outFile);
  const user = process.env.USERNAME || process.env.USER || '';
  const lines = [];
  const targetPart = `"${userTarget}"`;
  const outPart = userOut ? ` "${userOut}"` : '';

  if (err.code === 'ENOENT') {
    lines.push(`错误：无法创建输出文件 "${outFile}"（目录不存在）`);
    lines.push(`提示：先建好 "${dir}"，或把输出换到已存在的目录。`);
    return lines.join('\n');
  }

  lines.push(`错误：无法创建输出文件 "${outFile}"（${err.code}）`);

  if (err.code === 'EPERM' || err.code === 'EACCES') {
    lines.push('当前用户对这个目录没有写权限，盘符根目录经常如此。三种办法任选：');
    lines.push('  1) 加 --elevate 让脚本自己申请管理员权限：');
    lines.push(`     node ${script} ${targetPart}${outPart} --elevate`);
    lines.push('  2) 把输出换成有写权限的位置，例如：');
    lines.push(`     node ${script} ${targetPart} "$env:USERPROFILE\\tree.txt"`);
    lines.push('  3) 给该目录补写权限（需要管理员，会修改系统 ACL，请自行决定）：');
    lines.push(`     icacls "${dir}" /grant "${user}:(OI)(CI)(M)"`);
  } else {
    lines.push('提示：换一个输出位置试试：');
    lines.push(`     node ${script} ${targetPart} "$env:USERPROFILE\\tree.txt"`);
  }

  return lines.join('\n');
}

function isElevated() {
  if (process.platform !== 'win32') {
    return typeof process.getuid === 'function' && process.getuid() === 0;
  }

  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())' +
        '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    ],
    { encoding: 'utf8' }
  );

  return (result.stdout || '').trim().toLowerCase() === 'true';
}

function psPath(text) {
  return "'" + String(text).replace(/'/g, "''") + "'";
}

function winArgQuote(text) {
  const s = String(text);
  let out = '';
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    if (ch === '\\') {
      let count = 0;
      while (i < s.length && s[i] === '\\') {
        count += 1;
        i += 1;
      }
      if (i >= s.length) {
        out += '\\'.repeat(count * 2);
      } else if (s[i] === '"') {
        out += '\\'.repeat(count * 2 + 1) + '"';
        i += 1;
      } else {
        out += '\\'.repeat(count);
      }
    } else if (ch === '"') {
      out += '\\"';
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }

  return '"' + out + '"';
}

function psArgument(text) {
  return "'" + winArgQuote(text).replace(/'/g, "''") + "'";
}

function relaunchElevated(relaunchArgs) {
  const script = path.resolve(process.argv[1] || __filename);
  const argList = [script, ...relaunchArgs].map(psArgument).join(', ');
  const command = [
    `$p = Start-Process -FilePath ${psPath(process.execPath)} -ArgumentList ${argList} -Verb RunAs -PassThru`,
    'if ($p) { $p.WaitForExit(); exit $p.ExitCode }',
    'exit 1',
  ].join('; ');

  const result = spawnSync('powershell', ['-NoProfile', '-Command', command], {
    stdio: 'inherit',
  });

  if (result.error || result.status === null) {
    process.stderr.write('提权失败：无法启动 PowerShell，请手动以管理员身份运行。\n');
    return 1;
  }
  if (result.status !== 0) {
    process.stderr.write(`提权进程结束，退出码 ${result.status}（若 UAC 被取消，请手动以管理员身份运行）。\n`);
  }
  return result.status;
}

function buildRelaunchArgs(root, outArg, outFile, options) {
  const args = [root];
  if (outArg) args.push(outFile);
  args.push('--_elevated');
  if (options.depth !== Infinity) args.push('--depth', String(options.depth));
  if (options.jobs !== DEFAULT_JOBS) args.push('--jobs', String(options.jobs));
  if (!options.progress) args.push('--no-progress');
  return args;
}

function askYesNo(questionText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(questionText, (answer) => {
      rl.close();
      const text = answer.trim().toLowerCase();
      resolve(text === '' || text === 'y' || text === 'yes');
    });
  });
}

class Progress {
  constructor(enabled) {
    this.enabled = Boolean(enabled) && Boolean(process.stderr.isTTY);
    this.dirs = 0;
    this.entries = 0;
    this.startedAt = Date.now();
    this.timer = null;
    this.finished = false;

    if (this.enabled) {
      this.timer = setInterval(() => this.draw(), 200);
      this.timer.unref();
    }
  }

  addDir() {
    this.dirs += 1;
  }

  addEntries(count) {
    this.entries += count;
  }

  draw() {
    const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(0);
    process.stderr.write(
      `\r扫描中：${this.dirs} 个目录 / ${this.entries} 个条目（${seconds}s）   `
    );
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) clearInterval(this.timer);
    if (this.enabled) {
      this.draw();
      process.stderr.write('\n');
    }
  }
}

function scanTree(root, depth, jobs, progress, skipDir, skipName) {
  const blocks = new Map();
  const waiting = [];
  let running = 0;
  let outstanding = 0;
  let resolveDone = null;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function pump() {
    while (running < jobs && waiting.length > 0) {
      run(waiting.shift());
    }
  }

  function push(task) {
    outstanding += 1;
    waiting.push(task);
    pump();
  }

  function run(task) {
    running += 1;
    scanOne(task).then(
      () => settle(),
      () => settle()
    );
  }

  function settle() {
    running -= 1;
    outstanding -= 1;
    progress.addDir();
    if (outstanding === 0) resolveDone();
    else pump();
  }

  function scanOne(task) {
    const prefix = task.prefix;
    const level = task.level;

    return fsp.readdir(toLongPath(task.dir), { withFileTypes: true }).then(
      (entries) => {
        if (sameText(task.dir, skipDir)) {
          entries = entries.filter((entry) => !sameText(entry.name, skipName));
        }

        entries.sort(compareEntries);
        progress.addEntries(entries.length);

        const lines = [];
        const children = [];
        const last = entries.length - 1;

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const isLast = i === last;
          const branch = isLast ? ELBOW : TEE;

          if (entry.isSymbolicLink()) {
            lines.push(prefix + branch + entry.name + '  [link]');
            continue;
          }

          if (entry.isDirectory()) {
            lines.push(prefix + branch + entry.name + SEP);
            if (level < depth) {
              const childPath = joinChild(task.dir, entry.name);
              children.push({ index: lines.length - 1, path: childPath });
              push({
                dir: childPath,
                prefix: prefix + (isLast ? BLANK : PIPE),
                level: level + 1,
              });
            }
          } else {
            lines.push(prefix + branch + entry.name);
          }
        }

        blocks.set(task.dir, { lines, children });
      },
      (err) => {
        blocks.set(task.dir, {
          lines: [prefix + ELBOW + `[无法访问：${err.code || err.message}]`],
          children: [],
        });
      }
    );
  }

  push({ dir: root, prefix: '', level: 1 });
  return done.then(() => blocks);
}

function writeTree(blocks, root, fd) {
  const pending = [];
  let pendingSize = 0;

  function writeAll(fd, text) {
    const buffer = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
      if (written <= 0) throw new Error('写入输出文件失败');
      offset += written;
    }
  }

  function flush() {
    if (pending.length === 0) return;
    writeAll(fd, pending.join('\n') + '\n');
    pending.length = 0;
    pendingSize = 0;
  }

  function emit(line) {
    pending.push(line);
    pendingSize += line.length + 1;
    if (pendingSize >= FLUSH_THRESHOLD) flush();
  }

  emit(root);

  const stack = [{ dir: root, childIdx: 0, lineIdx: 0 }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const block = blocks.get(frame.dir);

    if (!block || frame.lineIdx >= block.lines.length) {
      stack.pop();
      continue;
    }

    emit(block.lines[frame.lineIdx]);

    const child = frame.childIdx < block.children.length ? block.children[frame.childIdx] : null;
    if (child !== null && child.index === frame.lineIdx) {
      frame.childIdx += 1;
      frame.lineIdx += 1;
      stack.push({ dir: child.path, childIdx: 0, lineIdx: 0 });
    } else {
      frame.lineIdx += 1;
    }
  }

  flush();
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));

  if (positional.length === 0) printHelp(1);
  if (positional.length > 2) {
    fail(`错误：多余的参数 "${positional[2]}"（用 -h 查看用法）`);
  }

  const root = normalizeRoot(positional[0]);
  const outArg = positional[1];
  const outFile = outArg ? path.resolve(outArg) : defaultOutPath(root);

  let rootStat;
  try {
    rootStat = fs.statSync(toLongPath(root));
  } catch (err) {
    fail(`错误：无法访问 "${root}"（${err.code}）`);
  }
  if (!rootStat.isDirectory()) {
    fail(`错误："${root}" 不是目录`);
  }

  const relaunchArgs = buildRelaunchArgs(root, outArg, outFile, options);

  if (options.elevate && !options.elevated && !isElevated()) {
    process.stdout.write('正在申请管理员权限…\n');
    process.exit(relaunchElevated(relaunchArgs));
  }

  let opened = tryOpenFile(outFile);

  if (opened.error) {
    const err = opened.error;
    const permissionIssue = err.code === 'EPERM' || err.code === 'EACCES';

    if (permissionIssue && !options.elevated && process.stdin.isTTY) {
      process.stdout.write(`无法在 "${outFile}" 创建文件（${err.code}）。\n`);
      const retry = await askYesNo('是否以管理员身份重新运行？[Y/n] ');
      if (retry) {
        process.stdout.write('正在申请管理员权限…\n');
        process.exit(relaunchElevated(relaunchArgs));
      }
    }

    if (!outArg) {
      for (const dir of [os.homedir(), os.tmpdir()]) {
        if (!dir) continue;
        const candidate = path.join(dir, path.basename(outFile));
        if (sameText(candidate, outFile)) continue;
        const attempt = tryOpenFile(candidate);
        if (!attempt.error) {
          process.stdout.write(`注意：无法写入 ${outFile}（${err.code}），已改写到 ${candidate}\n`);
          opened = attempt;
          break;
        }
      }
    }

    if (opened.error) {
      fail(buildOpenError(outFile, err, positional[0], outArg));
    }
  }

  const fd = opened.fd;
  const actualOut = opened.file;
  const progress = new Progress(options.progress);
  const startedAt = Date.now();
  const skipDir = path.dirname(actualOut);
  const skipName = path.basename(actualOut);

  try {
    const blocks =
      options.depth === 0
        ? new Map()
        : await scanTree(root, options.depth, options.jobs, progress, skipDir, skipName);
    progress.finish();
    writeTree(blocks, root, fd);
  } finally {
    progress.finish();
    fs.closeSync(fd);
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stdout.write(`树状图已写入 ${actualOut}（耗时 ${seconds} 秒）\n`);
}

main().catch((err) => {
  fail(`错误：${err && err.stack ? err.stack : err}`);
});
