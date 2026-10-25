#!/usr/bin/env node
'use strict';

// dirtree.js - 把盘符或文件夹里的所有内容画成树状图，写进一个文本文件

if (process.platform !== 'win32') {
  process.stderr.write('错误：dirtree 仅支持 Windows。\nError: dirtree only supports Windows.\n');
  process.exit(1);
}

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const POOL_SIZE = '64';
const VERSION = '1.0.0';
const RESULT_FILE_ENV = 'DIRTREE_RESULT_FILE';

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

// 界面文案：默认跟随系统语言（中文系统→zh，其他→en），
// 可用 --lang zh|en 或环境变量 DIRTREE_LANG 强制指定。
const MESSAGES = {
  zh: {
    help: `用法：node dirtree.js <盘符或文件夹> [输出文件] [选项]

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
      --lang zh|en  界面语言（默认跟随系统）
  -v, --version     显示版本号
  -h, --help        显示这段帮助

说明：
  · 仅支持 Windows
  · 目录名末尾带分隔符，文件不带；目录排在文件前面，各自按名称排序
  · 符号链接不跟随，只标注 [link]；没权限的目录标注 [无法访问]
  · 结果默认存在被扫描的盘/文件夹里；那里写不进去会问你是否用管理员
    身份重跑，也会告诉你文件最终存到了哪里
`,
    needPositiveInt: (name, text) => `错误：${name} 需要正整数，收到 "${text}"`,
    minOne: (name) => `错误：${name} 至少为 1`,
    maxLimit: (name, max) => `错误：${name} 最大 ${max}`,
    badDepth: (text) => `错误：--depth 需要 0 或正整数，收到 "${text}"`,
    badLang: (text) => `错误：--lang 只接受 zh 或 en，收到 "${text}"`,
    missingValue: (arg) => `错误：${arg} 后面缺少数值`,
    unknownOption: (arg) => `错误：未知选项 "${arg}"（用 -h 查看用法）`,
    tooManyArgs: (arg) => `错误：多余的参数 "${arg}"（用 -h 查看用法）`,
    cannotAccess: (root, code) => `错误：无法访问 "${root}"（${code}）`,
    notADirectory: (root) => `错误："${root}" 不是目录`,
    requestingElevation: '正在申请管理员权限…\n',
    cannotCreate: (file, code) => `无法在 "${file}" 创建文件（${code}）。\n`,
    askElevate: '是否以管理员身份重新运行？[Y/n] ',
    fallbackNote: (from, code, to) => `注意：无法写入 ${from}（${code}），已改写到 ${to}\n`,
    elevateSpawnFailed: '提权失败：无法启动 PowerShell，请手动以管理员身份运行。\n',
    elevateExit: (status) => `提权进程结束，退出码 ${status}（若 UAC 被取消，请手动以管理员身份运行）。\n`,
    scanning: (dirs, entries, seconds) => `扫描中：${dirs} 个目录 / ${entries} 个条目（${seconds}s）`,
    inaccessible: (code) => `[无法访问：${code}]`,
    writeFailed: '写入输出文件失败',
    canceled: '\n已取消：未完成的输出文件已删除。\n',
    done: (out, seconds) => `树状图已写入 ${out}（耗时 ${seconds} 秒）`,
    crash: (detail) => `错误：${detail}`,
    openError: function (outFile, err, userTarget, userOut) {
      const script = path.basename(process.argv[1] || 'dirtree.js');
      const dir = path.dirname(outFile);
      const user = process.env.USERNAME || process.env.USER || '';
      const targetPart = `"${userTarget}"`;
      const outPart = userOut ? ` "${userOut}"` : '';

      if (err.code === 'ENOENT') {
        return [
          `错误：无法创建输出文件 "${outFile}"（目录不存在）`,
          `提示：先建好 "${dir}"，或把输出换到已存在的目录。`,
        ].join('\n');
      }

      const lines = [`错误：无法创建输出文件 "${outFile}"（${err.code}）`];

      if (err.code === 'EPERM' || err.code === 'EACCES') {
        lines.push('当前用户对这个目录没有写权限，盘符根目录经常如此。三种办法任选：');
        lines.push('  1) 加 --elevate 让脚本自己申请管理员权限：');
        lines.push(`     node ${script} ${targetPart}${outPart} --elevate`);
        lines.push('  2) 把输出换成有写权限的位置，例如：');
        lines.push(`     node ${script} ${targetPart} "%USERPROFILE%\\tree.txt"`);
        lines.push('  3) 给该目录补写权限（需要管理员，会修改系统 ACL，请自行决定）：');
        lines.push(`     icacls "${dir}" /grant "${user}:(OI)(CI)(M)"`);
      } else {
        lines.push('提示：换一个输出位置试试：');
        lines.push(`     node ${script} ${targetPart} "%USERPROFILE%\\tree.txt"`);
      }

      return lines.join('\n');
    },
  },
  en: {
    help: `Usage: node dirtree.js <drive or folder> [output file] [options]

Draw every file and folder under the given location as a tree, saved
to a text file.

Examples:
  node dirtree.js D:                      scan drive D → D:\\D_drive_tree.txt
  node dirtree.js D:\\Photos photos.txt    scan a folder → photos.txt
  node dirtree.js D: --depth 2            expand two levels only

Options:
  -d, --depth N     expand N levels only (default: all)
  -j, --jobs N      folders processed concurrently (default ${DEFAULT_JOBS})
      --elevate     run as administrator (shows a UAC prompt)
      --no-progress do not show scanning progress
      --lang zh|en  interface language (default: system)
  -v, --version     print the version
  -h, --help        show this help

Notes:
  · Windows only
  · Directory names end with a path separator, file names do not;
    directories sort before files, each group sorted by name
  · Symbolic links are marked [link] and not followed; directories that
    cannot be read are marked [inaccessible]
  · Output defaults to the scanned drive/folder; if that is not writable
    you will be asked whether to retry as administrator, and the final
    output location is always reported
`,
    needPositiveInt: (name, text) => `Error: ${name} expects a positive integer, got "${text}"`,
    minOne: (name) => `Error: ${name} must be at least 1`,
    maxLimit: (name, max) => `Error: ${name} must not exceed ${max}`,
    badDepth: (text) => `Error: --depth expects 0 or a positive integer, got "${text}"`,
    badLang: (text) => `Error: --lang accepts zh or en only, got "${text}"`,
    missingValue: (arg) => `Error: ${arg} requires a value`,
    unknownOption: (arg) => `Error: unknown option "${arg}" (see -h for usage)`,
    tooManyArgs: (arg) => `Error: unexpected extra argument "${arg}" (see -h for usage)`,
    cannotAccess: (root, code) => `Error: cannot access "${root}" (${code})`,
    notADirectory: (root) => `Error: "${root}" is not a directory`,
    requestingElevation: 'Requesting administrator rights...\n',
    cannotCreate: (file, code) => `Cannot create "${file}" (${code}).\n`,
    askElevate: 'Retry as administrator? [Y/n] ',
    fallbackNote: (from, code, to) => `Note: cannot write ${from} (${code}); wrote to ${to} instead\n`,
    elevateSpawnFailed: 'Elevation failed: cannot start PowerShell; run as administrator manually.\n',
    elevateExit: (status) => `Elevated process exited with code ${status} (if UAC was cancelled, run as administrator manually).\n`,
    scanning: (dirs, entries, seconds) => `Scanning: ${dirs} dirs / ${entries} entries (${seconds}s)`,
    inaccessible: (code) => `[inaccessible: ${code}]`,
    writeFailed: 'Failed to write the output file',
    canceled: '\nCanceled: the unfinished output file was deleted.\n',
    done: (out, seconds) => `Tree written to ${out} (${seconds}s)`,
    crash: (detail) => `Error: ${detail}`,
    openError: function (outFile, err, userTarget, userOut) {
      const script = path.basename(process.argv[1] || 'dirtree.js');
      const dir = path.dirname(outFile);
      const user = process.env.USERNAME || process.env.USER || '';
      const targetPart = `"${userTarget}"`;
      const outPart = userOut ? ` "${userOut}"` : '';

      if (err.code === 'ENOENT') {
        return [
          `Error: cannot create output file "${outFile}" (directory does not exist)`,
          `Hint: create "${dir}" first, or write to an existing directory.`,
        ].join('\n');
      }

      const lines = [`Error: cannot create output file "${outFile}" (${err.code})`];

      if (err.code === 'EPERM' || err.code === 'EACCES') {
        lines.push('The current user cannot write to this directory (drive roots are often like this). Pick one:');
        lines.push('  1) Add --elevate to let the script request administrator rights:');
        lines.push(`     node ${script} ${targetPart}${outPart} --elevate`);
        lines.push('  2) Write to a writable location instead, e.g.:');
        lines.push(`     node ${script} ${targetPart} "%USERPROFILE%\\tree.txt"`);
        lines.push('  3) Grant write access to that directory (needs admin, changes system ACLs):');
        lines.push(`     icacls "${dir}" /grant "${user}:(OI)(CI)(M)"`);
      } else {
        lines.push('Hint: try a different output location:');
        lines.push(`     node ${script} ${targetPart} "%USERPROFILE%\\tree.txt"`);
      }

      return lines.join('\n');
    },
  },
};

// 提前扫一眼 --lang，让解析阶段报错时就已经选对了语言
function preScanLang(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let value = null;
    if (arg === '--lang') value = argv[i + 1] !== undefined ? argv[i + 1] : null;
    else if (arg.startsWith('--lang=')) value = arg.slice('--lang='.length);
    if (value !== null) {
      value = value.toLowerCase();
      if (value === 'zh' || value === 'en') return value;
    }
  }
  return null;
}

function detectLanguage() {
  const fromEnv = (process.env.DIRTREE_LANG || '').trim().toLowerCase();
  if (fromEnv.startsWith('zh')) return 'zh';
  if (fromEnv.startsWith('en')) return 'en';
  let locale = '';
  try {
    locale = (Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase();
  } catch {
    locale = '';
  }
  return locale.startsWith('zh') ? 'zh' : 'en';
}

const argv = process.argv.slice(2);
const t = MESSAGES[preScanLang(argv) || detectLanguage()];
const { positional, options } = parseArgs(argv);

// 解析放在重启之前：-h/-v/参数错误就不用白白多启动一个进程
if (!process.env.UV_THREADPOOL_SIZE) {
  const restarted = spawnSync(process.execPath, process.argv.slice(1), {
    env: { ...process.env, UV_THREADPOOL_SIZE: POOL_SIZE },
    stdio: 'inherit',
  });
  process.exit(restarted.status === null ? 1 : restarted.status);
}

// 提权后的子进程跑在新开的控制台窗口里，输出一闪而过看不到；
// 让它把收尾消息写进这个文件，由原进程读出来转述。
function writeResultFile(message) {
  const target = process.env[RESULT_FILE_ENV];
  if (!target) return;
  try {
    fs.writeFileSync(target, message + '\n');
  } catch {
    // 转述失败不影响主流程
  }
}

function fail(message) {
  process.stderr.write(message + '\n');
  writeResultFile(message);
  process.exit(1);
}

function printHelp(code) {
  process.stdout.write(t.help);
  process.exit(code);
}

function parsePositiveInt(text, name, max) {
  if (!/^\d+$/.test(text)) fail(t.needPositiveInt(name, text));
  const value = Number(text);
  if (value < 1) fail(t.minOne(name));
  if (max !== undefined && value > max) fail(t.maxLimit(name, max));
  return value;
}

function parseDepth(text) {
  if (!/^\d+$/.test(text)) fail(t.badDepth(text));
  return Number(text);
}

function parseLangValue(text) {
  const value = String(text).toLowerCase();
  if (value !== 'zh' && value !== 'en') fail(t.badLang(text));
  return value;
}

function parseArgs(argv) {
  const positional = [];
  const options = {
    depth: Infinity,
    jobs: DEFAULT_JOBS,
    elevate: false,
    elevated: false,
    progress: true,
    lang: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) fail(t.missingValue(arg));
      return next;
    };

    if (arg === '-h' || arg === '--help') {
      printHelp(0);
    } else if (arg === '-v' || arg === '--version') {
      process.stdout.write(`dirtree ${VERSION}\n`);
      process.exit(0);
    } else if (arg === '--elevate') {
      options.elevate = true;
    } else if (arg === '--_elevated') {
      options.elevated = true;
    } else if (arg === '--no-progress') {
      options.progress = false;
    } else if (arg === '--lang') {
      options.lang = parseLangValue(value());
    } else if (arg.startsWith('--lang=')) {
      options.lang = parseLangValue(arg.slice('--lang='.length));
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
      fail(t.unknownOption(arg));
    } else {
      positional.push(arg);
    }
  }

  return { positional, options };
}

function normalizeRoot(input) {
  if (/^[A-Za-z]:$/.test(input)) return input + SEP;
  return path.resolve(input);
}

function toLongPath(target) {
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
  return a.toLowerCase() === b.toLowerCase();
}

function tryOpenFile(file) {
  try {
    return { fd: fs.openSync(file, 'w'), file };
  } catch (err) {
    return { error: err };
  }
}

function isElevated() {
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

function relayResultFile(resultFile) {
  let message = null;
  try {
    message = fs.readFileSync(resultFile, 'utf8');
  } catch {
    return; // 子进程没留下收尾消息就不补
  }
  try {
    fs.unlinkSync(resultFile);
  } catch {
    // 删不掉就留给系统清理临时目录，不影响结果
  }
  message = message.trim();
  if (message) process.stdout.write(message + '\n');
}

function relaunchElevated(relaunchArgs) {
  const script = path.resolve(process.argv[1] || __filename);
  const argList = [script, ...relaunchArgs].map(psArgument).join(', ');
  const command = [
    `$p = Start-Process -FilePath ${psPath(process.execPath)} -ArgumentList ${argList} -Verb RunAs -PassThru`,
    'if ($p) { $p.WaitForExit(); exit $p.ExitCode }',
    'exit 1',
  ].join('; ');

  const resultFile = path.join(os.tmpdir(), `dirtree-result-${process.pid}.txt`);
  const result = spawnSync('powershell', ['-NoProfile', '-Command', command], {
    stdio: 'inherit',
    env: { ...process.env, [RESULT_FILE_ENV]: resultFile },
  });
  relayResultFile(resultFile);

  if (result.error || result.status === null) {
    process.stderr.write(t.elevateSpawnFailed);
    return 1;
  }
  if (result.status !== 0) {
    process.stderr.write(t.elevateExit(result.status));
  }
  return result.status;
}

function buildRelaunchArgs(root, outArg, outFile, options) {
  const args = [root];
  if (outArg) args.push(outFile);
  args.push('--_elevated');
  if (options.lang) args.push('--lang', options.lang);
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
    process.stderr.write(`\r${t.scanning(this.dirs, this.entries, seconds)}   `);
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
          lines: [prefix + ELBOW + t.inaccessible(err.code || err.message)],
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
      if (written <= 0) throw new Error(t.writeFailed);
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
  if (positional.length === 0) printHelp(1);
  if (positional.length > 2) {
    fail(t.tooManyArgs(positional[2]));
  }

  const root = normalizeRoot(positional[0]);
  const outArg = positional[1];
  const outFile = outArg ? path.resolve(outArg) : defaultOutPath(root);

  let rootStat;
  try {
    rootStat = fs.statSync(toLongPath(root));
  } catch (err) {
    fail(t.cannotAccess(root, err.code));
  }
  if (!rootStat.isDirectory()) {
    fail(t.notADirectory(root));
  }

  const relaunchArgs = buildRelaunchArgs(root, outArg, outFile, options);

  if (options.elevate && !options.elevated && !isElevated()) {
    process.stdout.write(t.requestingElevation);
    process.exit(relaunchElevated(relaunchArgs));
  }

  let opened = tryOpenFile(outFile);

  if (opened.error) {
    const err = opened.error;
    const permissionIssue = err.code === 'EPERM' || err.code === 'EACCES';

    if (permissionIssue && !options.elevated && process.stdin.isTTY) {
      process.stdout.write(t.cannotCreate(outFile, err.code));
      const retry = await askYesNo(t.askElevate);
      if (retry) {
        process.stdout.write(t.requestingElevation);
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
          process.stdout.write(t.fallbackNote(outFile, err.code, candidate));
          opened = attempt;
          break;
        }
      }
    }

    if (opened.error) {
      fail(t.openError(outFile, err, positional[0], outArg));
    }
  }

  const fd = opened.fd;
  const actualOut = opened.file;
  const progress = new Progress(options.progress);
  const startedAt = Date.now();
  const skipDir = path.dirname(actualOut);
  const skipName = path.basename(actualOut);

  // Ctrl+C / Ctrl+Break：关掉并删掉没写完的输出文件，不留半个结果误导人
  const cancel = () => {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(actualOut);
    } catch {}
    process.stderr.write(t.canceled);
    process.exit(130);
  };
  process.on('SIGINT', cancel);
  process.on('SIGBREAK', cancel);

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

  process.off('SIGINT', cancel);
  process.off('SIGBREAK', cancel);

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const message = t.done(actualOut, seconds);
  process.stdout.write(message + '\n');
  writeResultFile(message);
}

main().catch((err) => {
  fail(t.crash(err && err.stack ? err.stack : err));
});
