# Windows ZIP 发布

ZIP 和安装包共用构建产物，不需要额外启动器。在项目根目录执行：

```powershell
pnpm run prebuild x86_64-pc-windows-msvc
pnpm run build --target x86_64-pc-windows-msvc
pnpm portable x86_64-pc-windows-msvc
```

若只需要 ZIP，构建命令追加 `--no-bundle` 即可。ARM64 使用
`aarch64-pc-windows-msvc`，x86 使用 `i686-pc-windows-msvc`。
未传 `--target` 的本机构建对应 `pnpm portable`（不传平台参数）。

输出：`target/<target>/release/bundle/portable/Clash.Verge_<version>_<arch>_portable.zip`。
打包脚本也支持 `CARGO_TARGET_DIR`，无须 GitHub token。
Release、Auto Build 和 Dev 工作流会额外上传 ZIP，保留安装包。

ZIP 包含 `clash-verge.exe`、两个 Mihomo EXE、`resources/` 和空文件 `PORTABLE`。
解压到可写目录后运行，`config.yaml`、`verge.yaml`、`profiles.yaml`、
`profiles/`、`logs/` 等直接保存在 EXE 所在目录，与启动时的工作目录无关。
不存在 `PORTABLE` 时仍使用原来的系统用户数据目录。

不会自动迁移原来的配置。需要沿用时，退出程序，将原用户数据目录中的配置
及 `profiles/` 等所需数据复制到解压目录。更新时退出程序后覆盖程序文件；
ZIP 不包含用户配置，不要先删除整个旧目录。

继续使用系统 WebView2；Windows 服务仍通过应用内服务安装功能管理。
这不是服务与浏览器缓存都随目录移动的完整便携模式。
现有更新策略不变：后台更新任务未启动，自动检查默认关闭，手动更新入口仍保留。
ZIP 版本应下载新版 ZIP 手动覆盖，应用内安装更新仍走安装包流程。
