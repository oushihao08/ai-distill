<!-- 文件职责：说明前端服务端 API 客户端与请求契约。 -->
# API 请求

`client.ts` 的 `api<T>(path, init)` 调用 `/api` 前缀接口，读取 JSON 并将 HTTP、空响应、非 JSON 和网络异常转为可展示错误；204 允许无正文。

调用方提供请求体、请求头和可选 AbortSignal，自行管理加载与错误状态。泛型只是静态契约，不对返回值进行运行时结构校验。开发代理由 `web/vite.config.ts` 配置，服务端接口定义在根目录 `server/`。
