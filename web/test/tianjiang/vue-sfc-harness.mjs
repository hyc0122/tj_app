import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

let viteServer;

export async function loadSfc(modulePath) {
  const loaded = await loadModule(modulePath);
  return loaded.default;
}

export async function loadModule(modulePath) {
  viteServer ??= await createServer({
    configFile: fileURLToPath(new URL("../../vite.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("../../", import.meta.url)),
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  return viteServer.ssrLoadModule(modulePath);
}

export async function closeSfcHarness() {
  await viteServer?.close();
  viteServer = undefined;
}

export function installDom(url = "http://localhost/") {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"app\"></div></body></html>", { url });
  const previous = new Map();
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    Storage: dom.window.Storage,
    Event: dom.window.Event,
    Element: dom.window.Element,
    SVGElement: dom.window.SVGElement,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    getComputedStyle: dom.window.getComputedStyle,
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  return () => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor === undefined) delete globalThis[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
  };
}

export const tdesignStubs = {
  TDialog: {
    props: ["visible"],
    template: "<div v-if=\"visible\" role=\"dialog\"><slot /></div>",
  },
  TForm: { template: "<form><slot /></form>" },
  TFormItem: { template: "<label><slot /></label>" },
  TInput: {
    props: ["modelValue", "type", "placeholder"],
    emits: ["update:modelValue"],
    template:
      "<input :type=\"type || 'text'\" :value=\"modelValue\" :placeholder=\"placeholder\" @input=\"$emit('update:modelValue', $event.target.value)\" />",
  },
  TButton: {
    props: ["loading", "disabled"],
    emits: ["click"],
    template:
      "<button type=\"button\" :disabled=\"loading || disabled\" @click=\"$emit('click', $event)\"><slot name=\"icon\" /><slot /></button>",
  },
  TDropdown: { template: "<div><slot /></div>" },
  TTag: { template: "<span><slot /></span>" },
  TEmpty: { props: ["description"], template: "<div>{{ description }}</div>" },
  TAlert: { template: "<div><slot /></div>" },
  TLoading: { template: "<div><slot /></div>" },
  TInputNumber: {
    props: ["modelValue"],
    emits: ["update:modelValue"],
    template:
      "<input type=\"number\" :value=\"modelValue\" @input=\"$emit('update:modelValue', Number($event.target.value))\" />",
  },
  TSelect: {
    props: ["modelValue"],
    emits: ["update:modelValue"],
    template: "<select :value=\"modelValue\" @change=\"$emit('update:modelValue', $event.target.value)\"><slot /></select>",
  },
  ITranslate: true,
  ISettingTwo: true,
};
