import { v4 as uuidv4 } from "uuid";
import { buildCreateProjectBody, type CreateProjectBody } from "../project/create-project";

/** 一次用户创建意图只生成一个 clientCreateRequestId，网络重试必须复用。 */
export function createPersonalCanvasRequest(input: {
  name: string;
  clientCreateRequestId?: string;
}): CreateProjectBody {
  return buildCreateProjectBody({
    name: input.name,
    scope: "personal",
    businessType: "canvas",
    clientCreateRequestId: input.clientCreateRequestId || uuidv4(),
  });
}
