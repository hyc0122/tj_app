/**
 * 供应商模型列表存储：模板模型 + 自定义模型 + 用户删除排除集。
 * 保证用户主动删除后，模板刷新/vendor2json 不会立刻补回。
 */

export type VendorModelRecord = {
  modelName: string;
  name?: string;
  type?: string;
  [key: string]: unknown;
};

/** models 列解析结果；兼容旧版纯数组。 */
export interface VendorModelsState {
  /** 用户自定义/覆盖写入的模型 */
  custom: VendorModelRecord[];
  /** 用户从可见列表删除、禁止模板再合并的 modelName */
  excluded: string[];
}

function isModelRecord(value: unknown): value is VendorModelRecord {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as VendorModelRecord).modelName === "string"
    && String((value as VendorModelRecord).modelName).length > 0,
  );
}

/**
 * 解析 o_vendorConfig.models。
 * 旧格式：模型数组；新格式：{ custom, excluded }。
 * @param options.strict 默认失败关闭；仅明确传 false 的只读兼容场景可宽容。
 * @param options.label 严格模式错误标签前缀
 */
export function parseVendorModelsState(
  raw: string | null | undefined,
  options?: { strict?: boolean; label?: string },
): VendorModelsState {
  // 模型配置属于用户数据：损坏时必须停写，不能静默视为空数组后覆盖原值。
  const strict = options?.strict !== false;
  const label = options?.label ?? "供应商模型";
  if (raw == null || String(raw).trim() === "") {
    return { custom: [], excluded: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    if (strict) {
      throw new Error(`${label} JSON 损坏，已停止迁移以保护原始数据`);
    }
    return { custom: [], excluded: [] };
  }
  if (Array.isArray(parsed)) {
    return {
      custom: parsed.filter(isModelRecord),
      excluded: [],
    };
  }
  if (parsed && typeof parsed === "object") {
    const object = parsed as Record<string, unknown>;
    const customSource = Array.isArray(object.custom)
      ? object.custom
      : Array.isArray(object.models)
        ? object.models
        : [];
    const excludedSource = Array.isArray(object.excluded)
      ? object.excluded
      : Array.isArray(object.excludedTemplateModelNames)
        ? object.excludedTemplateModelNames
        : [];
    // 严格模式：对象须至少可识别 custom/excluded/models 之一，禁止任意对象当模型。
    if (
      strict
      && !Array.isArray(object.custom)
      && !Array.isArray(object.models)
      && !Array.isArray(object.excluded)
      && !Array.isArray(object.excludedTemplateModelNames)
    ) {
      throw new Error(`${label} JSON 类型无效，已停止迁移以保护原始数据`);
    }
    return {
      custom: customSource.filter(isModelRecord),
      excluded: excludedSource
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim()),
    };
  }
  if (strict) {
    throw new Error(`${label} JSON 类型无效，已停止迁移以保护原始数据`);
  }
  return { custom: [], excluded: [] };
}

/** 序列化写回；无 excluded 时保持旧数组格式，降低兼容面。 */
export function serializeVendorModelsState(state: VendorModelsState): string {
  const custom = state.custom.filter(isModelRecord);
  const excluded = [...new Set(state.excluded.map((name) => String(name).trim()).filter(Boolean))];
  if (excluded.length === 0) {
    return JSON.stringify(custom);
  }
  return JSON.stringify({ custom, excluded });
}

/** 合并模板与自定义，并应用排除集（后写覆盖同名）。 */
export function mergeVendorModelList(
  templateModels: VendorModelRecord[],
  state: VendorModelsState,
): VendorModelRecord[] {
  const excluded = new Set(state.excluded);
  const combined: VendorModelRecord[] = [
    ...templateModels.filter((model) => model?.modelName && !excluded.has(model.modelName)),
    ...state.custom.filter((model) => model?.modelName),
  ];
  const map = new Map<string, VendorModelRecord>();
  for (const model of combined) {
    map.set(model.modelName, model);
  }
  return [...map.values()];
}

export type DeleteVendorModelResult =
  | { ok: true; state: VendorModelsState; list: VendorModelRecord[] }
  | { ok: false; message: string };

/**
 * 从可见列表删除 modelName。
 * - 自定义：从 custom 移除；
 * - 模板或同名模板：加入 excluded，阻止补回。
 */
export function deleteVendorModelFromState(
  templateModels: VendorModelRecord[],
  state: VendorModelsState,
  modelName: string,
): DeleteVendorModelResult {
  const name = String(modelName ?? "").trim();
  if (!name) {
    return { ok: false, message: "模型不存在或已删除" };
  }
  const visible = mergeVendorModelList(templateModels, state);
  if (!visible.some((model) => model.modelName === name)) {
    return { ok: false, message: "模型不存在或已删除" };
  }

  const templateNames = new Set(
    templateModels
      .map((model) => model?.modelName)
      .filter((item): item is string => typeof item === "string" && item.length > 0),
  );
  const nextCustom = state.custom.filter((model) => model.modelName !== name);
  const nextExcluded = new Set(state.excluded.filter((item) => item !== name));
  // 模板中存在该名时必须排除，否则合并逻辑会立刻补回。
  if (templateNames.has(name)) {
    nextExcluded.add(name);
  }

  const nextState: VendorModelsState = {
    custom: nextCustom,
    excluded: [...nextExcluded],
  };
  return {
    ok: true,
    state: nextState,
    list: mergeVendorModelList(templateModels, nextState),
  };
}

/** 新增/更新自定义模型时取消同名排除，使列表可再次出现。 */
export function upsertCustomVendorModel(
  state: VendorModelsState,
  model: VendorModelRecord,
): VendorModelsState {
  if (!isModelRecord(model)) {
    return state;
  }
  const custom = state.custom.filter((item) => item.modelName !== model.modelName);
  custom.push(model);
  return {
    custom,
    excluded: state.excluded.filter((name) => name !== model.modelName),
  };
}
