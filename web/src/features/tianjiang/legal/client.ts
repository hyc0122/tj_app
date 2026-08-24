import axios from "@/utils/axios";
import {
  parseRendererLegalDocuments,
  type LegalDocumentsResult,
} from "./contracts";

/** 只请求本地固定代理，禁止自定义主机。 */
export async function fetchLegalDocuments(): Promise<LegalDocumentsResult> {
  const response = await axios.get("/tianjiang/public/legal-documents");
  // axios 拦截器已解包为 response.data 形状；兼容 data 嵌套。
  return parseRendererLegalDocuments(response);
}
