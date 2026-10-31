# Atelier · 生图服务

服务器自托管的第一版：账号池、API 密钥、持久图片队列、OSS 上传和一个管理后台。

## 技术结构

- React 19 / TanStack Start（SPA 模式）/ Vite / Tailwind CSS / shadcn 风格的 Radix 组件。
- Bun 同时提供静态后台、HTTP API、账号巡检和任务调度。
- SQLite WAL 保存账号与任务，AES-256-GCM 加密账号凭证和 OSS 密钥。API 密钥只存哈希。
- 图片协议暂复用 `basketikun/chatgpt2api` 的 Python 适配代码，通过隔离子进程调用；不启动原项目服务，不读取原项目账号池。
- 无 Redis、无外部数据库。当前只支持一个服务实例，不能使用多个进程或副本共享同一个数据库调度。

## 本地启动

需要 Bun 1.4+ 和 Python 3.13。

```sh
bun install --frozen-lockfile
python3 -m venv .venv
.venv/bin/pip install -r adapter/requirements.txt
bun run setup
```

把 `.env` 中 `PYTHON_BIN` 设置为虚拟环境 Python 的绝对路径。`setup` 会生成管理员密钥和加密主密钥；已有配置不会覆盖。

```sh
bun run build
bun run start
```

打开 `http://127.0.0.1:3080`，使用 `.env` 中的 `ADMIN_KEY` 登录。开发时使用 `bun run dev`，界面位于 5173，接口位于 3080。后台运行可使用 `scripts/service.sh start`，通过 `BUN_BIN` 指定 Bun 路径。

## 服务器部署

```sh
# 先准备 .env 中的 ADMIN_KEY、MASTER_KEY、BASE_URL
docker compose up -d --build
```

Compose 默认仅监听宿主机 `127.0.0.1:3080`，由服务器的 HTTPS 反向代理转发。将 `BASE_URL` 设置为实际访问的 HTTPS 域名；HTTPS 下登录 Cookie 启用 Secure。账号和图片保存在持久卷 `atelier_data` 中。

请备份数据库和 `MASTER_KEY`。丢失主密钥后，数据库中的加密凭证无法恢复。服务启动会恢复尚未上传的图片；重启时仍在生成且无本地结果的图片会标记为失败，由管理员确认后重试，避免重复扣上游额度。

## 第一次接入

1. 在「账号池 → 添加账号 → 授权登录」获取设备码，打开 OpenAI 官方页面，登录并输入设备码。后台会自动换取凭证、加密保存并验证账号，无需复制 Token。此方式添加的是 Codex 来源账号；网页 Token 和已有 JSON 仍可在「手动导入」中添加。
2. 在「服务设置」配置 OSS。保存后点击测试，实际验证一次写入、读取和删除。图片访问域名留空时使用私有签名 URL，查询任务时重新签名。
3. 推荐客户端将图片直传 OSS，并添加允许读取的参考图域名。接口也接受 SDK 上传的图片文件。参考图最多 7 张、单图 10 MB，支持 PNG/JPEG/WebP；URL 仅接受允许域名的 HTTPS 地址，禁止重定向和私网目标。
4. 在「API 密钥」创建业务密钥。完整密钥只显示一次，不要使用管理员密钥接入业务。
5. 创建本地演示可查看队列流程。演示输出是固定 SVG，明确标记为演示，不调用 ChatGPT，也不测试 OSS。

生图并发按账号限制：每个账号在「账号池」中设置并发上限（1～30，新账号默认 1），总容量等于所有可用账号的并发上限之和，单个任务的图片可以占用任意空闲名额。调度优先把图片分给负载率（处理中 ÷ 上限）最低的账号，负载相同时选最久未使用的账号。生图请求由常驻的 Python 进程池处理（默认 4 个接收新请求的进程，`ADAPTER_WORKERS` 可调），每个进程用线程同时等待多张图片。设置 `ADAPTER_POOL=0` 可回退为每张图片一个独立进程，用于对比或排查问题。队列容量默认 500 张。Web 额度在分配时预占，生成完成后扣减；Codex 的独立图片额度不能从网页额度接口推断，所以显示为「未获取」。

参考图从 OSS 按块下载到暂存文件，以文件路径传给 Python。Codex 链路按块将参考图编码到请求临时文件，通过 curl 读取回调上传，避免等待上游时保留整份 Base64 和 JSON 请求体。上游响应也按块落到临时文件，随后逐个解析 SSE 事件，取得一张结果后释放重复事件；每个 Python 进程默认同时解析、解码最多 2 张结果图（`ADAPTER_IMAGE_PROCESSING`，1～32），其余请求继续等待，不持有完整结果图的内存副本。参考图下载和 OSS 结果上传共用最多 4 个传输名额（`IMAGE_TRANSFER_CONCURRENCY`，1～32）；上传直接读取结果文件。

Codex 请求体和响应的匿名临时文件在请求结束或进程退出时自动关闭、删除。该方式以临时磁盘空间和 I/O 换取较低内存；可通过 `TMPDIR` 指定已有且可写的磁盘目录，使用 tmpfs 会占用内存。内存还取决于图片大小、并发和分配器行为，不能把“100 张并发低于 1 GB”当作所有负载的保证。业务只需要图片地址时使用异步任务接口，或显式设置 `response_format: "url"`，避免再次从 OSS 读取图片并编码返回。

单个请求超时后图片判为失败，但 Python 线程无法中途取消：在该请求真正结束前，账号名额保持占用、这张图片不能重试，迟到的结果会被丢弃；所在进程不再接收新请求，只剩超时请求时立即回收。每次尝试写入独立的暂存文件。

任务列表显示总耗时（从提交到结束，包含排队）和已结束图片的平均处理耗时。详情中每张图片分别显示排队等待与本次处理耗时，处理时间包含参考图读取、生图及上传，进行中每 3 秒更新。重试重新记录本次排队和开始时间；仅重传时显示本次重传时间，任务总耗时仍保留完整的提交至结束时长。旧记录没有时间信息时显示「—」。

账号巡检遇到 TLS、连接超时等临时网络故障，会最多尝试 3 次；仍失败则显示网络错误，并约 30～45 秒后自动重新验证。失效凭证不走这条快速重试流程，图片生成也不会自动重发。验证前若刷新了 Token，后续网络故障不会丢失已轮换的凭证。此机制改善临时故障恢复，不代表解决服务器出站网络本身的问题。

图片按张写入暂存文件，再上传 OSS。上传失败保留文件，点击重试仅补传，不重新生图。上传成功后清理暂存文件；本地存储和上传失败文件需要管理员定期清理，第一版还没有自动清理策略。

上传的参考图保存在私有的 `data/references/` 中，按内容去重，支持排队、服务重启和重试；不通过 `/media/` 对外提供访问。当前同样需要定期清理，清理前应确认没有待执行或待重试的任务引用这些图片。直接上传文件会占用服务入口带宽；继续使用 OSS 地址可省去客户端到服务这一段图片上传流量。

## HTTP API

所有业务接口需要 `Authorization: Bearer <业务密钥>`。密钥只能查询自己提交的任务。

```sh
curl https://your-service.example/v1/image-tasks \
  -H "Authorization: Bearer $IMAGE_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-001' \
  -d '{"model":"gpt-image-2","prompt":"极简护肤品广告摄影","n":7}'
```

返回 HTTP 202 和任务对象。轮询 `GET /v1/image-tasks/{id}`；每张图片有独立的 `queued/generating/uploading/success/error` 状态和结果 `url`。

- `POST /v1/images/generations`：同步返回，默认 `response_format: "url"`，也支持 `b64_json`。
- `POST /v1/images/edits`：接受 `multipart/form-data` 的 `image` 单文件或 `image[]` 多文件，以及 JSON 图片地址。默认返回 `data[].b64_json`，可显式设置 `response_format: "url"` 返回存储地址。
- 支持字段：`model`、`image`、`prompt`、`size`、`quality`、`n`（1～7）、`response_format`。`size` 支持 `auto`、`1024x1024`（默认）、`1536x1024`、`1024x1536`；`quality` 支持 `auto`（默认）、`low`、`medium`、`high`，Sunburst 另支持 `xhigh`、`max`。当前只输出 PNG，不支持 mask、透明背景、其他输出格式或 SSE。
- 上述两个同步接口也接受 `async: true` 返回 HTTP 202 的任务对象，这是本服务的扩展。
- 同步等待最多 180 秒。超时返回 HTTP 504 和 `task_id`；后台任务继续执行，应查询已有任务，勿直接重新提交。
- `POST /v1/image-tasks/{id}/retry`：重试失败图片；已有暂存结果仅重传。已取消任务不可重试。
- `POST /v1/image-tasks/{id}/cancel`：取消尚未开始的图片；正在生成的图片仍完成并保存。
- `GET /v1/models`：`gpt-image-2`（网页来源）、`codex-gpt-image-2`（Codex 来源，使用上游 `gpt-image-2`）和 `gpt-image-2.5-sunburst`（Codex 来源，原样传递模型名）。上游是否允许 Sunburst 取决于账号与提供方能力，接口兼容并不代表账号已获得该模型权限。

Codex 链路内部使用 `gpt-6.1-sol` 调用图片工具，可通过服务端环境变量 `CODEX_RESPONSES_MODEL` 修改，重启后生效。客户端 `model` 字段仍然传图片模型（例如 `gpt-image-2.5-sunburst`），不需要改成文本模型。旧版写死的 `gpt-5.5` 已不适用于 ChatGPT 登录的 Codex；参考[官方模型说明](https://learn.chatgpt.com/docs/models?surface=web)。

Codex 请求复用适配器已有的 curl_cffi 客户端，以使用一致的 TLS、压缩解码和代理设置；不会在连接异常后自动重复发起出图请求。

Python SDK 图片编辑（`pip install openai`）：

```python
import base64
import os
from contextlib import ExitStack
from openai import OpenAI

client = OpenAI(
    base_url="http://192.168.31.26:3080/v1",  # 换成实际服务地址
    api_key=os.environ["IMAGE_API_KEY"],
    timeout=240.0,
    max_retries=0,  # 避免等待超时后自动重复提交；可用幂等键安全重试
)
with ExitStack() as stack:
    images = [stack.enter_context(open(path, "rb")) for path in ["person.png", "scene.png", "style.png"]]
    resp = client.images.edit(
        model="gpt-image-2.5-sunburst",
        image=images,
        prompt="把图1人物放进图2场景，沿用图3的色彩风格，保持光线一致",
        size="1536x1024",
        quality="high",
        extra_headers={"Idempotency-Key": "order-001-edit"},
    )
with open("fused.png", "wb") as file:
    file.write(base64.b64decode(resp.data[0].b64_json))
```

JSON / OSS 输入示例（可使用 `image`、`image_urls` 或 `images: [{"image_url": "https://..."}]`，一次请求只选一种）：

```json
{
  "model": "gpt-image-2.5-sunburst",
  "image": ["https://your-oss.example/person.png", "https://your-oss.example/scene.png", "https://your-oss.example/style.png"],
  "prompt": "把图1人物放进图2场景，沿用图3的色彩风格，保持光线一致",
  "size": "1536x1024",
  "quality": "high",
  "response_format": "url"
}
```

上传请求总大小最多 72 MB（非上传 JSON 最多 1 MB）。如使用反向代理，也需允许这个请求大小及至少 180 秒的同步响应等待。Base64 返回 OSS 结果时，服务器需要从 OSS 读取图片，因此业务服务仅需地址时建议使用 `response_format: "url"`。异步接口始终返回任务对象及图片 URL。

幂等标识按业务密钥隔离；相同标识和相同参数返回原任务，即使账号额度已耗尽；相同标识但不同参数返回错误。

## 设备码授权

- 设备码最长有效 15 分钟。浏览器只取得官方页面、设备码和进度，设备会话标识、授权码与 Token 不会返回前端。
- 服务端按提供方要求的间隔轮询；限流时退避。取消或过期后清除加密的临时授权信息；取消后迟到的结果不会导入。
- 完成授权时验证 PKCE、ID Token 签名、签发者、客户端和有效期，随后保存凭证与对应的 `client_id`、刷新地址和过期时间。生图可用性单独验证。
- 关闭弹窗取消等待；浏览器刷新后重新打开弹窗可恢复未过期的等待。服务器重启后未完成授权失效，需要重新开始。
- 若官方提示设备码登录未启用，请在 ChatGPT 安全设置或工作空间权限中开启。该功能当前为 Beta，网络或账号权限不支持时可手动导入。
- 每个管理员登录会话同时只保留一次授权，设备码仅用于本人刚刚发起的登录。不要分享设备码或替别人确认授权。
- 默认使用 Codex 设备码客户端。如需指定已获准使用的客户端，可在服务端设置 `CODEX_OAUTH_CLIENT_ID`。它必须支持对应设备码流程，不能任意替换。

管理接口：`POST /api/accounts/authorize` 发起；`GET /api/accounts/authorize/{id}` 查询；`DELETE /api/accounts/authorize/{id}` 取消。仅管理员可用，授权状态绑定到发起时的登录会话。

## 检查与当前验证范围

```sh
bun run check
bun test
python3 adapter/test_bridge.py
bun run build
```

可选的 Linux 内存回归检查（使用安装了适配器依赖的 Python）：

```sh
.venv/bin/python scripts/benchmark-memory.py --max-mib 1024
```

脚本以本地假上游验证 100 张 Codex 图片并发，分别测试无参考图、每请求一张约 3 MiB 参考图；所有结果约 3 MiB 并集中返回。它记录 Bun 适配器加 4 个真实 Python worker 的采样 RSS/PSS，核对每张结果的内容哈希，并在 PSS 超过指定值时失败，不读取实际账号或调用真实生图服务。PSS 会分摊共享内存，但不包含文件缓存、真实 TLS/OSS、完整 HTTP 服务和客户端 Base64 响应开销，因此不是容器内存硬上限测试。临时测试数据会自动清理。

自动检查覆盖鉴权、凭证加密、账号去重、业务任务隔离、设备码轮询与取消、JWT 验签、幂等、并发与额度预占、队列上限、重启恢复、仅补传和 7 张演示流程。图片编辑检查覆盖多文件上传、大小与内容限制、图片顺序、尺寸和质量持久化、Base64 / URL 返回、OSS 结果读取以及重复提交去重。Python 检查验证凭证刷新与上游图片工具的模型和参数传递。没有实际完成账号授权和配置 OSS 时，不能确认上游真实出图和云存储可用性。Docker 配置需在安装 Docker 的服务器上构建验证。

## 协议代码来源

`adapter/protocol/` 中的协议代码来自 https://github.com/basketikun/chatgpt2api ，固定参考提交 `92dd80e`，保留原始 MIT LICENSE。原作者 README 另有用途限制声明，商业上线前需澄清其授权表述。当前适配器保留上游协议实现与依赖，以便独立更新；项目未提供官方 API 权益，也不保证网页协议长期稳定。
