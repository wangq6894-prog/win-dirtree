#!/usr/bin/env node
'use strict';

// dirtree.js 冒烟测试：构造一棵临时目录树，跑脚本，比对输出。
// 用法：node test.js（或 npm test）

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SCRIPT = path.join(__dirname, 'dirtree.js');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL ${name}\n     ${(err && err.message) || err}`);
  }
}

function runDirtree(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

// ---------- 构造测试目录 ----------
// docs\alpha\deep.txt、docs\notes.txt、z-dir\file.txt、a.md、b10.txt、b2.txt

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dirtree-test-'));
const fixtureDir = path.join(workDir, 'fixture');
const outDir = path.join(workDir, 'out');
fs.mkdirSync(path.join(fixtureDir, 'docs', 'alpha'), { recursive: true });
fs.mkdirSync(path.join(fixtureDir, 'z-dir'));
fs.mkdirSync(outDir);
fs.writeFileSync(path.join(fixtureDir, 'docs', 'alpha', 'deep.txt'), 'x');
fs.writeFileSync(path.join(fixtureDir, 'docs', 'notes.txt'), 'x');
fs.writeFileSync(path.join(fixtureDir, 'z-dir', 'file.txt'), 'x');
fs.writeFileSync(path.join(fixtureDir, 'a.md'), 'x');
fs.writeFileSync(path.join(fixtureDir, 'b10.txt'), 'x');
fs.writeFileSync(path.join(fixtureDir, 'b2.txt'), 'x');

const rootLine = path.resolve(fixtureDir);

// ---------- 基本扫描 ----------

const outFile = path.join(outDir, 'tree.txt');
const mainRun = runDirtree([fixtureDir, outFile, '--no-progress']);
const tree = fs.readFileSync(outFile, 'utf8');
const lines = tree.split('\n');

check('扫描成功，退出码 0', () => {
  assert.strictEqual(mainRun.status, 0, `stderr: ${mainRun.stderr}`);
  assert.ok(mainRun.stdout.includes('树状图已写入'), `stdout: ${mainRun.stdout}`);
});
check('首行是根目录的绝对路径', () => assert.strictEqual(lines[0], rootLine));
check('目录排在文件前面，各自按名称排序', () => {
  const expected = ['├── docs\\', '├── z-dir\\', '├── a.md', '├── b10.txt', '└── b2.txt'];
  let prev = -1;
  for (const line of expected) {
    const at = lines.indexOf(line);
    assert.ok(at !== -1 && at > prev, `缺少或顺序不对：${line}`);
    prev = at;
  }
});
check('子目录按层级正确缩进', () => {
  assert.ok(lines.includes('│   ├── alpha\\'), '缺少 alpha 行');
  assert.ok(lines.includes('│   │   └── deep.txt'), '缺少 deep.txt 行');
  assert.ok(lines.includes('│   └── notes.txt'), '缺少 notes.txt 行');
  assert.ok(lines.includes('│   └── file.txt'), '缺少 file.txt 行');
});

// ---------- --depth ----------

const outDepth1 = path.join(outDir, 'depth1.txt');
runDirtree([fixtureDir, outDepth1, '--depth', '1', '--no-progress']);
const depth1 = fs.readFileSync(outDepth1, 'utf8');
check('--depth 1 只展开一层', () => {
  assert.ok(depth1.includes('├── docs\\'));
  assert.ok(!depth1.includes('alpha'), '不该出现第二层目录');
  assert.ok(!depth1.includes('deep.txt'), '不该出现第二层文件');
});

const outDepth0 = path.join(outDir, 'depth0.txt');
runDirtree([fixtureDir, outDepth0, '--depth', '0', '--no-progress']);
const depth0 = fs.readFileSync(outDepth0, 'utf8');
check('--depth 0 只有一行根路径', () => assert.strictEqual(depth0, rootLine + '\n'));

// ---------- 符号链接（需要开发者模式或管理员权限，不行就跳过） ----------

let symlinkTried = false;
try {
  fs.mkdirSync(path.join(fixtureDir, 'real-target'));
  fs.writeFileSync(path.join(fixtureDir, 'real-target', 'marker.txt'), 'x');
  fs.symlinkSync(path.join(fixtureDir, 'real-target'), path.join(fixtureDir, 'mylink'), 'dir');
  symlinkTried = true;
} catch {
  console.log('跳过符号链接测试：当前环境无法创建符号链接（需要开发者模式或管理员）');
}

if (symlinkTried) {
  const outLink = path.join(outDir, 'link.txt');
  runDirtree([fixtureDir, outLink, '--no-progress']);
  const linkTree = fs.readFileSync(outLink, 'utf8');
  check('符号链接标注 [link] 且不跟随', () => {
    assert.ok(linkTree.includes('mylink  [link]'), '缺少 [link] 标注');
    assert.strictEqual(linkTree.split('marker.txt').length - 1, 1, '链接下的内容被重复展开');
  });
}

// ---------- 输出文件自排除 ----------

const defaultRun = runDirtree([fixtureDir, '--no-progress']);
check('默认输出写在被扫目录里且不包含自身', () => {
  assert.strictEqual(defaultRun.status, 0, `stderr: ${defaultRun.stderr}`);
  const defaultOut = path.join(fixtureDir, 'fixture_tree.txt');
  const defaultTree = fs.readFileSync(defaultOut, 'utf8');
  assert.ok(!defaultTree.includes('fixture_tree.txt'), '输出文件出现在了树里');
});

// ---------- 参数校验 ----------

check('-h 打印帮助并以 0 退出', () => {
  const r = runDirtree(['-h']);
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('用法'));
});
check('--depth 传非数字时报错退出', () => {
  const r = runDirtree([fixtureDir, '--depth', 'abc']);
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('错误'));
});
check('未知选项报错退出', () => {
  const r = runDirtree([fixtureDir, '--wat']);
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('未知选项'));
});
check('路径不存在时报错退出', () => {
  const r = runDirtree([path.join(workDir, 'no-such-dir')]);
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('无法访问'));
});

// ---------- 收尾 ----------

fs.rmSync(workDir, { recursive: true, force: true });

console.log(`\n${passed} 项通过，${failures.length} 项失败`);
if (failures.length > 0) {
  console.error('失败项：' + failures.join('、'));
  process.exit(1);
}
