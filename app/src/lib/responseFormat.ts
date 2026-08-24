export interface ApiResponse {
  code: number;
  data: any;
  message: string;
}

// 成功回调
export function success<T>(data: T | null = null, message: string = "成功"): ApiResponse {
  return {
    code: 200,
    data,
    message,
  };
}

// 错误响应：HTTP 状态码与响应体 code 必须保持一致。
export function error<T>(
  message: string = "",
  data: T | null = null,
  code: number = 400,
): ApiResponse {
  return {
    code,
    data,
    message,
  };
}
