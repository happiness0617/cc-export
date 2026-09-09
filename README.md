# cc-export

将 Claude Code 的 session 对话历史导出为 Markdown 文档。

每个 session 导出两个文件：
- `<session-id>.md` — 完整对话内容（一问一答格式）
- `<session-id>.meta.md` — 元信息与统计分析

导出文件统一放在对应项目目录下的 `sessions/` 子目录中。

## 安装

```bash
npm install
npm link   # 全局安装 cc-export 命令（可选）
```

不安装也可以直接用 `node index.js <command>`。

## 命令

### `list` — 列出所有 session

```bash
cc-export list
cc-export list --project bobi        # 按路径关键词过滤
cc-export list --json                # JSON 格式输出
```

每条记录显示：session ID、项目路径、轮次数、开始时间、首条消息摘要。

---

### `export` — 导出单个 session

```bash
cc-export export --id <session-uuid>
cc-export export --id <uuid> --from 5 --to 20   # 只导出第 5-20 轮
```

输出到 `<项目目录>/sessions/<uuid>.md` 和 `<uuid>.meta.md`。

---

### `export-dir` — 批量导出某目录下所有 session

```bash
cc-export export-dir /home/ubuntu/projects/bobi-日常管理系统开发
```

匹配该目录及所有子目录下的 session，各自输出到对应项目目录的 `sessions/` 下。

---

### `update` — 更新单个 session（覆盖重写）

```bash
cc-export update --id <session-uuid>
```

用于 session 仍在进行时，刷新已导出的文件。

---

### `update-dir` — 批量更新某目录下所有 session

```bash
cc-export update-dir /home/ubuntu/projects/bobi-日常管理系统开发
```

---

## 输出结构示例

```
/home/ubuntu/projects/bobi-日常管理系统开发/
└── sessions/
    ├── 0b26fc12-134c-40a8-ba0d-eed9a0781be7.md
    ├── 0b26fc12-134c-40a8-ba0d-eed9a0781be7.meta.md
    ├── 86ca43d1-7d32-448e-bf1d-45e2da9032e4.md
    └── 86ca43d1-7d32-448e-bf1d-45e2da9032e4.meta.md
```

子目录的 session 也按各自的真实路径归位：

```
/home/ubuntu/projects/bobi-日常管理系统开发-frontend/
└── sessions/
    └── 3e018eb0-f206-48c0-9871-c4ba117ee039.md
```

---

## 元信息报告内容

每个 `<session-id>.meta.md` 包含：

- **基本信息**：Session ID、项目路径、Claude Code 版本、开始/结束时间、持续时长。
- **对话统计**：有效轮次、用户/AI 消息数、双方字数、单轮输入与回复的最小/平均/最大长度。
- **模型与 Token 消耗**：每个模型的 AI 消息数；输入、输出、缓存创建、缓存读取及计入请求总 Token。Token 来自 Claude Code JSONL 中每条 AI 消息记录的实际 `usage` 字段。
- **服务层级与工具调用**：standard 等服务层级的消息分布、工具调用次数，以及（如存在）服务端 Web Search / Fetch 请求数。
- **主题摘要**：首条用户消息的截断摘要。

示例：

```markdown
## 模型与 Token 消耗

| 指标 | Token |
|------|------:|
| 输入 Token | 3,223,164 |
| 输出 Token | 27,183 |
| 合计 Token（不含缓存） | 3,250,347 |
| 缓存创建 Token | 562,639 |
| 缓存读取 Token | 8,329,686 |
| 计入请求的总 Token | 12,142,672 |

### 模型使用分布

| 模型 | AI 消息数 |
|------|----------:|
| claude-sonnet-4-6 | 85 |
```

> Token 统计是 session 内各 AI 消息 `usage` 的累计值。缓存 Token 反映请求处理量，不等同于模型输出或账单金额。

---

## 数据来源

Session 文件位于 `~/.claude/projects/<encoded-path>/<session-uuid>.jsonl`，每行一条 JSON 消息。cc-export 解析其中的 `user`（`promptId` 标识真实用户输入）和 `assistant` 消息，跳过工具调用结果，按 `parentUuid` 链关联每轮的所有 AI 回复。
