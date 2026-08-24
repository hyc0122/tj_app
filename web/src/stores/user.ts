export default defineStore(
  "user",
  () => {
    const authenticated = ref(false);
    return { authenticated };
  },
  { persist: false },
);
