export function appendImageFiles(
  files: FileList | null,
  target: string[],
  input: HTMLInputElement,
) {
  if (!files?.length) return;
  for (const file of Array.from(files)) {
    const reader = new FileReader();
    reader.onload = () => {
      target.push(String(reader.result ?? ""));
    };
    reader.readAsDataURL(file);
  }
  input.value = "";
}
