import crypto from "node:crypto";
import {
  API_CONTRACT,
  matchAPIEndpoint,
  type ErrorCode,
} from "../contracts";
import { matchClientControlPlaneEndpoint } from "../client-control-plane-contracts";
import {
  CentralServiceUnavailableError,
  mapCentralError,
} from "./central-service-error";

export { mapCentralError } from "./central-service-error";

export const CENTRAL_SESSION_COOKIE = "tj_session";
export const CENTRAL_API_URL = "https://api.j11.com.cn";
const CENTRAL_AUTH_PATHS = {
  captcha: "/api/tianjiang/v1/auth/captcha",
  register: "/api/tianjiang/v1/auth/register",
  login: "/api/tianjiang/v1/auth/login",
  profile: "/api/tianjiang/v1/profile",
  password: "/api/tianjiang/v1/profile/password",
} as const;

export interface CentralPublicUser {
  id: number;
  username: string;
  nickname: string;
}

export interface CentralSession {
  id: string;
  serverUrl: string;
  token: string;
  expiresAt: number;
  user: CentralPublicUser;
  validatedAt: number;
}

export interface CreateCentralSession {
  serverUrl: string;
  token: string;
  expiresAt: number;
  user: CentralPublicUser;
}

export class MemoryCentralSessionStore {
  private readonly sessions = new Map<string, CentralSession>();

  create(input: CreateCentralSession): CentralSession {
    const id = crypto.randomBytes(32).toString("base64url");
    const session: CentralSession = {
      ...input,
      id,
      validatedAt: Date.now(),
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): CentralSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  update(session: CentralSession): void {
    this.sessions.set(session.id, session);
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  deleteAllExcept(activeSessionId: string): void {
    for (const sessionId of this.sessions.keys()) {
      if (sessionId !== activeSessionId) this.sessions.delete(sessionId);
    }
  }
}

export function buildSessionCookie(id: string, secure: boolean, maxAgeSeconds: number): string {
  const parts = [
    `${CENTRAL_SESSION_COOKIE}=${encodeURIComponent(id)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/api",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return buildSessionCookie("", secure, 0);
}

export function readSessionCookie(header: string | undefined): string {
  if (!header) return "";
  for (const item of header.split(";")) {
    const [name, ...rest] = item.trim().split("=");
    if (name === CENTRAL_SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export interface CentralLoginInput {
  username: string;
  password: string;
  captcha: string;
  captchaId: string;
}

export interface CentralRegisterInput extends CentralLoginInput {
  nickname: string;
}

export interface CentralProfileUpdateInput {
  username: string;
  nickname: string;
}

export interface CentralPasswordChangeInput {
  oldPassword: string;
  newPassword: string;
}

export interface CentralProfileMutationResult {
  user: CentralPublicUser;
  /** 仅在本地凭据原子提交成功后，路由才可把该暂存会话替换进内存。 */
  session: CentralSession;
}

export interface ServerUrlPolicy {
  readonly mode: "test-only-loopback-http";
  readonly serverUrl?: string;
}

export function createTestOnlyLoopbackPolicy(serverUrl?: string): ServerUrlPolicy {
  if (serverUrl !== undefined) {
    validateTestOnlyLoopbackURL(serverUrl);
  }
  return Object.freeze({
    mode: "test-only-loopback-http",
    ...(serverUrl === undefined ? {} : { serverUrl }),
  });
}

export interface GVAResponse<T> {
  code: number | ErrorCode | string;
  data?: T;
  msg?: string;
  request_id?: string;
  retryable?: boolean;
}

export interface CentralContractResponse {
  status: number;
  body: GVAResponse<unknown>;
  requestId: string;
}

export class CentralBusinessError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | ErrorCode | string,
    message: string,
    readonly requestId: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
  }
}

const GENERIC_REGISTER_MESSAGE = "注册申请未受理，请检查填写内容";
const GENERIC_LOGIN_MESSAGE = "中央认证失败";
const SAFE_CENTRAL_REQUEST_ERRORS = [
  // 当前中央 Gin 接口使用数值错误码 7；以下文案均由正式服务端固定产生。
  { pathname: CENTRAL_AUTH_PATHS.register, status: 400, code: 7, message: "请求参数无效" },
  { pathname: CENTRAL_AUTH_PATHS.register, status: 400, code: 7, message: "验证码错误" },
  { pathname: CENTRAL_AUTH_PATHS.register, status: 400, code: 7, message: "用户名或密码格式无效" },
  { pathname: CENTRAL_AUTH_PATHS.login, status: 400, code: 7, message: "请求参数无效" },
  { pathname: CENTRAL_AUTH_PATHS.login, status: 400, code: 7, message: "验证码错误" },
  { pathname: CENTRAL_AUTH_PATHS.login, status: 401, code: 7, message: "账号或密码错误" },
  // 同时兼容中央契约后续采用的稳定符号错误码。
  { pathname: CENTRAL_AUTH_PATHS.register, status: 400, code: "CAPTCHA_INVALID", message: "验证码错误" },
  { pathname: CENTRAL_AUTH_PATHS.register, status: 409, code: "USERNAME_TAKEN", message: "用户名已存在" },
  { pathname: CENTRAL_AUTH_PATHS.register, status: 409, code: "USERNAME_TAKEN", message: "用户名重复" },
  { pathname: CENTRAL_AUTH_PATHS.register, status: 422, code: "PASSWORD_POLICY", message: "密码不符合安全规则" },
  { pathname: CENTRAL_AUTH_PATHS.login, status: 400, code: "CAPTCHA_INVALID", message: "验证码错误" },
  { pathname: CENTRAL_AUTH_PATHS.profile, status: 400, code: 7, message: "请求参数无效" },
  { pathname: CENTRAL_AUTH_PATHS.profile, status: 400, code: 7, message: "用户名或昵称格式无效" },
  { pathname: CENTRAL_AUTH_PATHS.profile, status: 409, code: 7, message: "用户名已存在" },
  { pathname: CENTRAL_AUTH_PATHS.password, status: 400, code: 7, message: "请求参数无效" },
  { pathname: CENTRAL_AUTH_PATHS.password, status: 400, code: 7, message: "新密码不符合安全规则" },
  { pathname: CENTRAL_AUTH_PATHS.password, status: 401, code: 7, message: "原密码错误" },
] as const;

function safeCentralRequestError(
  pathname: string,
  status: number,
  body: GVAResponse<unknown>,
): {
  status: number;
  code: number | ErrorCode | string;
  message: string;
} {
  const message = typeof body?.msg === "string" ? body.msg.trim() : "";
  const known = SAFE_CENTRAL_REQUEST_ERRORS.find((candidate) => (
    candidate.pathname === pathname
    && candidate.status === status
    && candidate.code === body?.code
    && candidate.message === message
  ));
  if (known) return known;

  // 未知 code/message 可能携带内部标识或凭据，整组字段都不能透传。
  // 登录与注册使用不同安全回退，避免登录失败误报“注册申请未受理”。
  if (pathname === CENTRAL_AUTH_PATHS.login) {
    return {
      status: 401,
      code: 401,
      message: GENERIC_LOGIN_MESSAGE,
    };
  }
  if (pathname === CENTRAL_AUTH_PATHS.profile) {
    return { status: 400, code: 400, message: "个人资料修改失败" };
  }
  if (pathname === CENTRAL_AUTH_PATHS.password) {
    return { status: 400, code: 400, message: "密码修改失败" };
  }
  return {
    status: 400,
    code: 400,
    message: GENERIC_REGISTER_MESSAGE,
  };
}

/**
 * 中央请求的公开业务错误。仅 message/code/status 可返回浏览器，其他字段只用于进程内诊断。
 */
export class CentralRequestError extends Error {
  readonly name = "CentralRequestError";

  constructor(
    readonly status: number,
    readonly code: number | ErrorCode | string,
    message: string,
    readonly requestId: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
  }

  static fromResponse(
    pathname: string,
    status: number,
    body: GVAResponse<unknown>,
  ): CentralRequestError {
    const publicError = safeCentralRequestError(pathname, status, body);
    return new CentralRequestError(
      publicError.status,
      publicError.code,
      publicError.message,
      typeof body?.request_id === "string" ? body.request_id.slice(0, 128) : "",
      body?.retryable === true,
    );
  }
}

interface BusinessLoginData {
  token: string;
  expiresAt: number;
  user: {
    id: number;
    username: string;
    nickname: string;
  };
}

interface BusinessProfileData {
  user: CentralPublicUser;
}

export class CentralAuthGateway {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly serverUrlPolicy?: ServerUrlPolicy,
  ) {}

  async captcha(): Promise<Record<string, unknown>> {
    const response = await this.request<Record<string, unknown>>(CENTRAL_AUTH_PATHS.captcha, {
      method: "POST",
    });
    return response;
  }

  async register(input: CentralRegisterInput): Promise<void> {
    await this.request<Record<string, unknown>>(CENTRAL_AUTH_PATHS.register, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: input.username,
        nickname: input.nickname,
        password: input.password,
        captcha: input.captcha,
        captchaId: input.captchaId,
      }),
    });
  }

  async login(input: CentralLoginInput): Promise<{ session: CreateCentralSession; publicUser: CentralPublicUser }> {
    const data = await this.request<BusinessLoginData>(CENTRAL_AUTH_PATHS.login, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: input.username,
        password: input.password,
        captcha: input.captcha,
        captchaId: input.captchaId,
      }),
    });
    if (!data.token || !data.user || !data.user.id || !data.user.username) {
      throw new Error("中央认证失败");
    }
    const publicUser: CentralPublicUser = {
      id: data.user.id,
      username: data.user.username,
      nickname: data.user.nickname ?? "",
    };
    return {
      session: {
        serverUrl: this.centralServerUrl(),
        token: data.token,
        expiresAt: data.expiresAt,
        user: publicUser,
      },
      publicUser,
    };
  }

  async updateProfile(
    session: CentralSession,
    input: CentralProfileUpdateInput,
  ): Promise<CentralProfileMutationResult> {
    const stagedSession: CentralSession = { ...session, user: { ...session.user } };
    const data = await this.request<BusinessProfileData>(CENTRAL_AUTH_PATHS.profile, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-token": session.token,
      },
      body: JSON.stringify(input),
    }, stagedSession);
    const user = parseCentralPublicUser(data.user);
    stagedSession.user = user;
    return { user, session: stagedSession };
  }

  async changePassword(
    session: CentralSession,
    input: CentralPasswordChangeInput,
  ): Promise<CentralProfileMutationResult> {
    const stagedSession: CentralSession = { ...session, user: { ...session.user } };
    const data = await this.request<BusinessProfileData>(CENTRAL_AUTH_PATHS.password, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-token": session.token,
      },
      body: JSON.stringify(input),
    }, stagedSession);
    const user = parseCentralPublicUser(data.user);
    stagedSession.user = user;
    return { user, session: stagedSession };
  }

  async validate(session: CentralSession): Promise<CentralSession> {
    await this.request<Record<string, unknown>>(
      "/api/tianjiang/v1/session",
      { method: "GET", headers: { "x-token": session.token } },
      session,
    );
    return session;
  }

  async logout(_session: CentralSession): Promise<void> {
    // 业务令牌不暴露给浏览器；退出时销毁本地内存会话即可。
  }

  async forwardBusinessRequest(
    session: CentralSession,
    pathname: string,
    method: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.forwardContractRequest(session, pathname, method, body);
    if (response.status < 200 || response.status >= 300 || response.body.code !== 0) {
      throw new CentralBusinessError(
        response.status,
        response.body.code,
        response.body.msg || "中央业务请求失败",
        response.requestId,
        response.body.retryable ?? false,
      );
    }
    return response.body.data ?? null;
  }

  async forwardContractRequest(
    session: CentralSession,
    pathname: string,
    method: string,
    body?: unknown,
    requestId: string = crypto.randomUUID(),
  ): Promise<CentralContractResponse> {
    const normalizedMethod = method.toUpperCase();
    if (
      matchAPIEndpoint(normalizedMethod, pathname) === null
      && matchClientControlPlaneEndpoint(normalizedMethod, pathname) === null
    ) {
      throw new CentralBusinessError(404, "PROJECT_NOT_FOUND", "业务路径无效", requestId);
    }
    const response = await this.fetchCentral(joinCentralURL(session.serverUrl, pathname, this.serverUrlPolicy), {
      method: normalizedMethod,
      headers: {
        "x-token": session.token,
        [API_CONTRACT.requestIdHeader]: requestId,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const nextToken = response.headers.get("new-token");
    const nextExpiresAt = response.headers.get("new-expires-at");
    if (nextToken) {
      session.token = nextToken;
      if (nextExpiresAt && /^\d+$/.test(nextExpiresAt)) {
        session.expiresAt = Number(nextExpiresAt) * 1000;
      }
    }
    const result = (await response.json()) as GVAResponse<unknown>;
    return {
      status: response.status,
      body: result,
      requestId: response.headers.get(API_CONTRACT.requestIdHeader) || requestId,
    };
  }

  private async request<T>(
    pathname: string,
    init: RequestInit,
    session?: CentralSession,
  ): Promise<T> {
    const serverUrl = session?.serverUrl ?? this.centralServerUrl();
    const response = await this.fetchCentral(joinCentralURL(serverUrl, pathname, this.serverUrlPolicy), {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const availabilityError = mapCentralError({ status: response.status });
    if (availabilityError) {
      throw new CentralServiceUnavailableError(
        new Error(`中央认证 HTTP ${response.status}`),
        response.status,
      );
    }
    const nextToken = response.headers.get("new-token");
    const nextExpiresAt = response.headers.get("new-expires-at");
    if (session && nextToken) {
      session.token = nextToken;
      if (nextExpiresAt && /^\d+$/.test(nextExpiresAt)) {
        session.expiresAt = Number(nextExpiresAt) * 1000;
      }
    }
    const body = (await response.json()) as GVAResponse<T>;
    if (!response.ok || body.code !== 0 || body.data === undefined) {
      throw CentralRequestError.fromResponse(pathname, response.status, body);
    }
    return body.data;
  }

  private async fetchCentral(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(input, init);
    } catch (error) {
      // fetch reject 只代表中央链路失败；本地 Electron 服务此时仍正常工作。
      throw new CentralServiceUnavailableError(error);
    }
  }

  private centralServerUrl(): string {
    if (this.serverUrlPolicy?.serverUrl) {
      return normalizeServerUrl(this.serverUrlPolicy.serverUrl, this.serverUrlPolicy);
    }
    return CENTRAL_API_URL;
  }
}

function parseCentralPublicUser(value: CentralPublicUser): CentralPublicUser {
  if (!value || !Number.isSafeInteger(value.id) || value.id <= 0 || typeof value.username !== "string") {
    throw new Error("中央个人资料响应无效");
  }
  return {
    id: value.id,
    username: value.username,
    nickname: typeof value.nickname === "string" ? value.nickname : "",
  };
}

export function normalizeServerUrl(raw: string, policy?: ServerUrlPolicy): string {
  if (policy?.mode === "test-only-loopback-http") {
    // 必须先校验原始字符串，禁止 URL 解析器把缩写、整数或八进制 IP 归一化为 127.0.0.1。
    validateTestOnlyLoopbackURL(raw);
    return raw;
  }

  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("中央服务地址无效");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function joinCentralURL(serverUrl: string, pathname: string, policy?: ServerUrlPolicy): string {
  return `${normalizeServerUrl(serverUrl, policy)}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

function validateTestOnlyLoopbackURL(raw: string): void {
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(raw);
  if (!match) {
    throw new Error("测试中央服务地址无效");
  }
  const port = Number(match[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("测试中央服务地址无效");
  }

  // 原始串通过白名单后再让 URL 解析器做结构复核；默认端口 80 可能被归一化为空。
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("测试中央服务地址无效");
  }
}
