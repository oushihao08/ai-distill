/** 职责：页面用已有API身份向AppShell发布导航层级，避免面包屑额外请求；路由切换由外壳清空。 */
import type {InjectionKey} from 'vue';
export interface PageBreadcrumb {title:string;to?:string}
export const pageBreadcrumbKey:InjectionKey<(items:PageBreadcrumb[])=>void>=Symbol('page-breadcrumbs');
export function usePageBreadcrumbs(items:()=>PageBreadcrumb[]){
 const publish=inject(pageBreadcrumbKey);
 watch(items,value=>publish?.(value),{immediate:true});
}
