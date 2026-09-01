/** 中文注释：收费任务必须展示预览与费用，用户点击「确认执行」后才能提交。 */
export function requestTianjiangPaidConfirm(input: {
  fee?: { displayText?: string };
  message?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.setAttribute("data-tapcanvas-confirm", "1");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "执行预览");
    root.style.cssText = "position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)";
    const card = document.createElement("section");
    card.style.cssText = "min-width:360px;max-width:480px;padding:24px;border-radius:16px;background:#1a1b1e;color:#f4f6f8;font-family:inherit;box-shadow:0 12px 40px rgba(0,0,0,.4)";
    const title = document.createElement("h2");
    title.textContent = "执行预览";
    title.style.margin = "0 0 12px";
    const fee = document.createElement("p");
    fee.textContent = input.fee?.displayText || input.message || "该任务可能产生费用";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:12px;justify-content:flex-end;margin-top:20px";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.style.cssText = "padding:8px 16px;border:0;border-radius:8px;background:#2c2e33;color:#fff;cursor:pointer";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = "确认执行";
    confirm.style.cssText = "padding:8px 16px;border:0;border-radius:8px;background:#4c6ef5;color:#fff;cursor:pointer";
    cancel.addEventListener("click", () => {
      root.remove();
      resolve(false);
    });
    confirm.addEventListener("click", () => {
      root.remove();
      resolve(true);
    });
    actions.append(cancel, confirm);
    card.append(title, fee, actions);
    root.append(card);
    document.body.append(root);
  });
}
