import { api } from '../api/client';
export function useResource<T>(path: string) {
 const data = shallowRef<T>();
 const error = shallowRef('');
 const loading = shallowRef(false);
 let controller: AbortController | undefined;
 async function refresh() {
  if (loading.value) return;
  loading.value = true; error.value = '';
  controller = new AbortController();
  try { data.value = await api<T>(path, { signal: controller.signal }); }
  catch (cause) { if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '读取失败'; }
  finally { loading.value = false; }
 }
 onMounted(refresh);
 onUnmounted(() => controller?.abort());
 return { data, error, loading, refresh };
}
