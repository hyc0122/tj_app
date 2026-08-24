import { computed, onMounted, ref, shallowRef } from "vue";
import { fetchLegalDocuments } from "./client";
import type {
  LegalDocumentType,
  LegalDocumentsResult,
  PublicLegalDocument,
} from "./contracts";

const shared = shallowRef<LegalDocumentsResult | null>(null);
const loading = ref(false);
const loadError = ref(false);
let loadPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (shared.value) return;
  if (loadPromise) return loadPromise;
  loading.value = true;
  loadPromise = (async () => {
    try {
      shared.value = await fetchLegalDocuments();
      loadError.value = false;
    } catch {
      loadError.value = true;
      shared.value = {
        documents: [],
        source: "packaged",
        stale: true,
      };
    } finally {
      loading.value = false;
    }
  })();
  return loadPromise;
}

export function useLegalDocuments() {
  const openType = ref<LegalDocumentType | null>(null);

  onMounted(() => {
    void ensureLoaded();
  });

  const documents = computed(() => shared.value?.documents ?? []);
  const source = computed(() => shared.value?.source ?? "packaged");
  const stale = computed(() => shared.value?.stale === true);

  const activeDocument = computed<PublicLegalDocument | null>(() => {
    if (!openType.value) return null;
    return documents.value.find((item) => item.documentType === openType.value) ?? null;
  });

  function openDocument(type: LegalDocumentType) {
    openType.value = type;
  }

  function closeDocument() {
    openType.value = null;
  }

  return {
    loading,
    loadError,
    documents,
    source,
    stale,
    openType,
    activeDocument,
    openDocument,
    closeDocument,
    ensureLoaded,
  };
}
