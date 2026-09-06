// @vitest-environment jsdom
import { shallowMount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { describe, expect, it } from "vitest";
import ModelReferenceInput from "@/components/setting/components/vendorTest/ModelReferenceInput.vue";

const Input = defineComponent({
  name: "TInput", props: ["modelValue"], emits: ["update:modelValue"],
  template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
});

describe("佳速账号级素材输入", () => {
  it("URL 输入不创建文件或项目，三种媒体均原样交给服务端校验", async () => {
    for (const kind of ["image", "video", "audio"] as const) {
      const wrapper = shallowMount(ModelReferenceInput, {
        props: { kind, urlOnly: true, modelValue: null },
        global: { stubs: { TInput: Input } },
      });
      await wrapper.find("input").setValue(" https://media.example/opaque-reference ");
      expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["https://media.example/opaque-reference"]);
      expect(wrapper.findComponent({ name: "ImageUploadBox" }).exists()).toBe(false);
      wrapper.unmount();
    }
  });

  it("其他供应商仍使用文件上传组件，不强制 URL", () => {
    const file = new File(["fixture"], "image.png", { type: "image/png" });
    const wrapper = shallowMount(ModelReferenceInput, { props: { kind: "image", urlOnly: false, modelValue: file } });
    expect(wrapper.find("input").exists()).toBe(false);
    const upload = wrapper.findComponent({ name: "ImageUploadBox" });
    expect(upload.props("modelValue")).toBe(file);
    upload.vm.$emit("update:modelValue", null);
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([null]);
    wrapper.unmount();
  });
});
