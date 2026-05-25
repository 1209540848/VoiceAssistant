# 用户热词

## 目标

热词必须由用户自己维护，而不是开发者在代码里写死。

用户可以在主窗口的“我的热词”面板里添加专有名词、技术词、人名和产品名。保存后热词先落到本地配置；点击“同步热词”后，服务端会把这些词同步到 DashScope，拿到 `vocabulary_id`，后续 ASR 请求自动使用这个 ID。

## 当前链路

```text
用户编辑热词
-> POST /api/hot-words
-> 保存到本地 data/user-hotwords.json
-> 用户点击同步热词
-> POST /api/hot-words/sync
-> DashScope create_vocabulary / update_vocabulary
-> 保存 vocabulary_id
-> Fun-ASR run-task 带 vocabulary_id
```

## 本地文件

用户热词保存到：

```text
data/user-hotwords.json
```

这个文件已加入 `.gitignore`，不会提交到仓库。

## API

### 获取热词

```text
GET /api/hot-words
```

### 保存热词

```text
POST /api/hot-words
Content-Type: application/json

{
  "words": ["DashScope", "WebSocket", "实时转写"]
}
```

保存后状态会变成 `dirty: true`，表示本地已修改但还没有同步到 ASR。

### 同步热词

```text
POST /api/hot-words/sync
```

同步成功后会保存 DashScope 返回的 `vocabulary_id`，下一次录音开始生效。

## 高级兜底

仍保留：

```text
DASHSCOPE_VOCABULARY_ID=your-vocabulary-id
```

它只作为高级兜底，用于已经在 DashScope 控制台维护热词列表的情况。正常产品路径应该走用户热词面板。

如果后续切换到 Paraformer 等其他模型族，可以在 `.env.local` 调整热词目标模型：

```text
DASHSCOPE_HOT_WORDS_TARGET_MODEL=fun-asr
```

## 注意

- 热词不是本地纠错，不会强制替换文本。
- 热词只影响 ASR 识别倾向。
- 用户修改热词后必须点击“同步热词”才会影响识别。
- 如果同步失败，旧的 `vocabulary_id` 仍然保留，不影响现有识别链路。
