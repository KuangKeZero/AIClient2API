# Windows Codex GPT-5.5 配置包

这个目录是纯净自包含的 Windows Codex 配置包。它不依赖任何项目目录，也不读取项目里的配置文件、项目标识文件或外部脚本。

复制整个目录到 Windows 任意位置后即可运行。

## 它会修改什么

默认目标是当前 Windows 用户的 Codex 配置目录：

```text
%USERPROFILE%\.codex
```

脚本会写入或更新：

```text
%USERPROFILE%\.codex\config.toml
%USERPROFILE%\.codex\model-catalog.gpt-5.5.json
```

正式写入前会自动备份为：

```text
*.bak-gpt55-年月日时分秒
```

## 直接运行

双击：

```text
Run-Windows-Codex-GPT55-Setup.cmd
```

或在 PowerShell 里运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-codex-gpt55-models.ps1
```

先预览不写文件：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-codex-gpt55-models.ps1 -DryRun
```

## 默认配置

默认会把 Codex 配置为：

```toml
model = "gpt-5.5-free"
model_provider = "codexzh"
model_catalog_json = "%USERPROFILE%\\.codex\\model-catalog.gpt-5.5.json"

[model_providers.codexzh]
name = "codexzh"
base_url = "http://localhost:3001/openai-codex-oauth/v1"
wire_api = "responses"
requires_openai_auth = true
web_search = "live"
```

模型目录会包含：

```text
gpt-5.5
gpt-5.5-free
gpt-5.5-plus
gpt-5.5-pro
gpt-5.5 free
gpt-5.5 plus
gpt-5.5 pro
```

## 常用参数

如果你的本地代理或中转地址不是默认端口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-codex-gpt55-models.ps1 `
  -BaseUrl "http://127.0.0.1:3001/openai-codex-oauth/v1"
```

如果想默认使用 Plus：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-codex-gpt55-models.ps1 `
  -DefaultModel "gpt-5.5-plus"
```

如果 Codex 配置目录不是默认位置：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-codex-gpt55-models.ps1 `
  -CodexHome "D:\codex-config"
```
