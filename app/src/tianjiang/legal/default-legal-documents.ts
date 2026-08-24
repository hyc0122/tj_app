import type { PublicLegalDocument } from "./legal-document-contract";

/**
 * 安装包内嵌初始示例正文（首次离线且无缓存时使用）。
 * 第一行必须标明法务审核提示，禁止 TODO/TBD 占位。
 */
const LEGAL_DISCLAIMER =
  "此为初始示例内容，正式发布前需完成法务审核";

const USER_AGREEMENT_CONTENT = [
  LEGAL_DISCLAIMER,
  "",
  "一、账号使用",
  "您应合法注册并妥善保管天将漫创业务账号。禁止出借、共享或倒卖账号。",
  "",
  "二、内容合规",
  "您对上传、生成与发布的内容负责，不得制作或传播违法违规信息。",
  "",
  "三、服务可用性",
  "我们尽力保障服务稳定，但不对因网络、设备或不可抗力导致的中断承担无限责任。",
  "",
  "四、违规处理",
  "若发现滥用、攻击系统或违反本协议的行为，我们可限制或终止相关服务。",
  "",
  "五、联系渠道",
  "如有疑问，请通过产品内关于页或官方支持渠道联系我们。",
].join("\n");

const PRIVACY_POLICY_CONTENT = [
  LEGAL_DISCLAIMER,
  "",
  "一、账号信息",
  "我们处理业务账号标识、昵称与登录验证所需的最小信息。",
  "",
  "二、本地项目数据",
  "项目素材与工作数据主要保存在本机受控目录，按当前业务账号隔离。",
  "",
  "三、设备信息",
  "为设备登记与离线授权，可能使用稳定设备标识等最小技术信息。",
  "",
  "四、日志最小化",
  "诊断日志会脱敏，不记录密码、token、Cookie 或供应商密钥明文。",
  "",
  "五、个人密钥",
  "供应商和模型密钥按产品要求保存在当前用户本地数据中，不在团队间共享，也不得跨账号同步或写入日志。",
  "",
  "六、用户权利",
  "您可按产品能力管理账号、清除已保存账号并请求说明数据处理方式。",
].join("\n");

export const PACKAGED_LEGAL_DOCUMENTS: readonly PublicLegalDocument[] = Object.freeze([
  {
    documentType: "user_agreement",
    title: "用户协议（初始示例）",
    content: USER_AGREEMENT_CONTENT,
    version: "initial-2026-08-01",
    updatedAt: "2026-08-01T00:00:00Z",
  },
  {
    documentType: "privacy_policy",
    title: "隐私政策（初始示例）",
    content: PRIVACY_POLICY_CONTENT,
    version: "initial-2026-08-01",
    updatedAt: "2026-08-01T00:00:00Z",
  },
]);
