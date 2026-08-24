import db from "@/utils/db";
import oss from "@/utils/oss";
import getConfig from "./utils/getConfig";
import { v4 as uuid } from "uuid";
import error from "@/utils/error";
import cleanNovel from "./utils/cleanNovel";
import getPath from "@/utils/getPath";
import vm from "@/utils/vm";
import task from "@/utils/taskRecord";
import Ai from "@/utils/ai";
import { getPrompts } from "@/utils/getPrompts";
import { getArtPrompt } from "@/utils/getArtPrompt";
import replaceUrl from "@/utils/replaceUrl";
import writeVersion from "@/utils/writeVersion";
import * as vendor from "@/utils/vendor";

export default {
  db,
  /**
   * 账号配置库（db2）惰性访问。
   * 不得在模块顶层解构 accountDb：db 初始化会经 fixDB 回指 utils，导致 TDZ。
   */
  get accountDb() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/utils/db").accountDb as typeof db;
  },
  oss,
  getConfig,
  uuid,
  error,
  cleanNovel,
  vm,
  getPath,
  Ai,
  task,
  getPrompts,
  getArtPrompt,
  replaceUrl,
  writeVersion,
  vendor,
};
