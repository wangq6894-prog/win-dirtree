# dirtree

把盘符或文件夹里的所有文件和文件夹画成树状图，写进一个文本文件。

需要 Node.js 14+，无第三方依赖。

## 用法

```
node dirtree.js <盘符或文件夹> [输出文件] [选项]
```

例子：

```bat
node dirtree.js D:                    :: 扫 D 盘 → D:\D_drive_tree.txt
node dirtree.js "D:\我的照片" 相册.txt   :: 扫文件夹 → 相册.txt
node dirtree.js D: --depth 2          :: 只展开两层
node dirtree.js D: --elevate          :: 以管理员身份运行
```

路径含空格时用引号包起来。

| 选项 | 说明 |
| --- | --- |
| `-d, --depth N` | 只展开 N 层，默认全部展开 |
| `-j, --jobs N` | 同时处理的文件夹数，默认 32 |
| `--elevate` | 以管理员身份运行（会弹 UAC） |
| `--no-progress` | 不显示扫描进度 |
| `-h, --help` | 显示帮助 |

输出长这样：

```
D:\
├── Program Files\
│   └── ...
├── Documents and Settings  [link]
└── pagefile.sys
```

目录名末尾带分隔符，文件不带；目录排在文件前面，各自按名称排序。
符号链接只标注 `[link]` 不跟随，没有权限的目录标注 `[无法访问]`。

Windows 上也可以把盘符或文件夹直接拖到 `生成目录树-拖拽运行.cmd` 上运行。

## 速度测试

**测试环境**：Intel i7-14650HX（16 核 24 线程）/ 32 GB 内存 / YMTC PC411 1TB NVMe SSD，
Windows 11，Node.js 24。

**测试对象**：D 盘全盘，共 **1,134,288 个条目**，输出文本 **69 MB**。

| 并行度 | 耗时 |
| --- | --- |
| `--jobs 1`（单线程） | 3.7 s |
| `--jobs 8` | 1.4 s |
| `--jobs 32`（默认） | 1.2 s |
| `--jobs 64` | 1.2 s |

扫描期间内存峰值约 **392 MB**。

以上均为磁盘缓存热态下的数字；首次读取（冷缓存）会明显慢一些。

## 许可证

[MIT](LICENSE)
