/**
 * 归一化服务基址：剥掉末尾斜杠，并剥掉末尾的 `/v1` 版本段。
 *
 * 调用方（各 adapter）统一按 `${normalizeServiceBaseUrl(x)}/v1/...` 拼接，
 * 所以这里必须保证返回值**不带** `/v1` 结尾。用户填 `https://h/zen/go/v1`
 * 或 `https://h/zen/go` 都要得到同一个结果 `https://h/zen/go`。
 *
 * 只剥末尾一层：路径中间的 `/v1/`（如 `https://h/v1/proxy`）不动。
 */
export function normalizeServiceBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '').replace(/\/v1$/i, '');
}
